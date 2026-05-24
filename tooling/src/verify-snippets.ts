// verify-snippets.ts — re-fetch cited Wikipedia revisions and verify snippet presence.
//
// For each statement that has a snippet AND its source has a fetchable URL,
// fetches the raw wikitext and checks substring presence.
//
// Output per statement: "OK", "MISSING", or "ERROR" + stmt id + source id.
//
// Flags:
//   --source <kind>    filter by source kind (default: wikipedia only)

import { loadData } from "./lib/load.js";
import { q } from "./lib/store.js";
import { fetchSourceText } from "./lib/source-fetch.js";

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

if (args.includes("--help")) {
  console.log(
    "Usage: bun run verify-snippets [--source <kind>]\n" +
    "  --source <kind>   source kind to check (default: wikipedia)\n"
  );
  process.exit(0);
}

const sourceKindFilter = getArg("--source") ?? "wikipedia";

const db = loadData();

// Collect source metadata
interface SourceMeta {
  id: string;
  kind: string;
  url: string;
  revid?: number;
}

const sourceMeta = new Map<string, SourceMeta>();
for (const row of q({ q: [{ where: [["?e", "source/id", "?id"], ["?e", "source/kind", "?kind"], ["?e", "source/url", "?url"]] }], select: ["id", "kind", "url"] }, db)) {
  sourceMeta.set(row["id"] as string, { id: row["id"] as string, kind: row["kind"] as string, url: row["url"] as string });
}
for (const row of q({ q: [{ where: [["?e", "source/id", "?id"], ["?e", "source/revid", "?r"]] }], select: ["id", "r"] }, db)) {
  const meta = sourceMeta.get(row["id"] as string);
  if (meta) meta.revid = row["r"] as number;
}

// Collect src-links that have snippets
interface SrcLink {
  stmtId: string;
  sourceId: string;
  snippet: string;
}

const links: SrcLink[] = [];
for (const row of q(
  { q: [{ where: [
    ["?sl", "src-link/statement", "?sid"],
    ["?sl", "src-link/source",    "?srcid"],
    ["?sl", "src-link/snippet",   "?sn"],
  ]}], select: ["sid", "srcid", "sn"] },
  db,
)) {
  const sourceId = row["srcid"] as string;
  const meta = sourceMeta.get(sourceId);
  if (!meta || meta.kind !== sourceKindFilter) continue;
  if (meta.kind === "wikipedia" && !meta.revid) continue;
  links.push({ stmtId: row["sid"] as string, sourceId, snippet: row["sn"] as string });
}

if (links.length === 0) {
  console.log(`No verifiable snippets found for source kind '${sourceKindFilter}'.`);
  process.exit(0);
}

async function fetchRevision(sourceId: string, revid: number, url: string): Promise<string | null> {
  try {
    return await fetchSourceText(sourceId, { kind: "wikipedia", url, revid });
  } catch {
    return null;
  }
}

let ok = 0, missing = 0, error = 0;

for (const link of links) {
  const meta = sourceMeta.get(link.sourceId)!;
  if (!meta.revid) { error++; console.log(`ERROR  ${link.stmtId}  ${link.sourceId}  (no revid)`); continue; }
  const text = await fetchRevision(link.sourceId, meta.revid, meta.url);
  if (text === null) {
    error++;
    console.log(`ERROR  ${link.stmtId}  ${link.sourceId}  (fetch failed)`);
  } else if (text.includes(link.snippet)) {
    ok++;
    console.log(`OK     ${link.stmtId}  ${link.sourceId}`);
  } else {
    missing++;
    console.log(`MISSING  ${link.stmtId}  ${link.sourceId}`);
  }
}

console.log(`\nResults: ${ok} OK  ${missing} MISSING  ${error} ERROR`);
