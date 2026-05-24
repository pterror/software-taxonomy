// snippet-worklist.ts — build/refresh .snippet-worklist.json from the live corpus.
//
// Each entry represents a (statement, source-id) pair that needs a snippet.
// Idempotent: entries with status != "pending" are preserved; pending entries
// are refreshed; new pairs are added.

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { loadData } from "./lib/load.js";
import { q } from "./lib/store.js";
import { repoRoot } from "./lib/entity-file.js";

const WORKLIST_PATH = join(repoRoot, ".snippet-worklist.json");

export interface WorklistEntry {
  stmt_id: string;
  subject: string;
  subject_label: string | null;
  predicate: string;
  value: string;
  value_label: string | null;
  lens: string;
  source_id: string;
  source_url: string;
  source_revid: number | null;
  source_kind: string;
  status: "pending" | "proposed" | "accepted" | "rejected" | "unsupported";
  proposed_snippet: string | null;
  confidence: "high" | "medium" | "low" | null;
  notes: string | null;
  created_at: string;
  proposed_at: string | null;
  accepted_at: string | null;
}

const db = loadData();

// Collect stmt ids that already have at least one src-link with a non-empty snippet.
const snippetedStmts = new Set<string>();
for (const row of q(
  { q: [{ where: [["?sl", "src-link/statement", "?sid"], ["?sl", "src-link/snippet", "?sn"]] }], select: ["sid"] },
  db,
)) {
  snippetedStmts.add(row["sid"] as string);
}

// Collect all (stmt_id, source_id) pairs that lack a snippet.
interface SrcLinkInfo {
  stmtId: string;
  sourceId: string;
}
const needsSnippet: SrcLinkInfo[] = [];
for (const row of q(
  { q: [{ where: [["?sl", "src-link/statement", "?sid"], ["?sl", "src-link/source", "?srcid"]] }], select: ["sid", "srcid"] },
  db,
)) {
  const stmtId = row["sid"] as string;
  if (snippetedStmts.has(stmtId)) continue; // stmt already has a snippet somewhere
  needsSnippet.push({ stmtId, sourceId: row["srcid"] as string });
}

// Load source metadata.
interface SourceMeta {
  id: string;
  kind: string;
  url: string;
  revid?: number;
}
const sourceMeta = new Map<string, SourceMeta>();
for (const row of q(
  { q: [{ where: [["?e", "source/id", "?id"], ["?e", "source/kind", "?kind"], ["?e", "source/url", "?url"]] }], select: ["id", "kind", "url"] },
  db,
)) {
  sourceMeta.set(row["id"] as string, { id: row["id"] as string, kind: row["kind"] as string, url: row["url"] as string });
}
for (const row of q(
  { q: [{ where: [["?e", "source/id", "?id"], ["?e", "source/revid", "?r"]] }], select: ["id", "r"] },
  db,
)) {
  const m = sourceMeta.get(row["id"] as string);
  if (m) m.revid = row["r"] as number;
}

// Load statement metadata.
interface StmtMeta {
  subject: string;
  predicate: string;
  value: string;
  lens: string;
}
const stmtMeta = new Map<string, StmtMeta>();
for (const row of q(
  { q: [{ where: [
    ["?s", "statement/id", "?id"],
    ["?s", "statement/subject", "?subj"],
    ["?s", "statement/predicate", "?pred"],
    ["?s", "statement/value", "?val"],
    ["?s", "statement/lens", "?lens"],
  ]}], select: ["id", "subj", "pred", "val", "lens"] },
  db,
)) {
  stmtMeta.set(row["id"] as string, {
    subject:   row["subj"] as string,
    predicate: row["pred"] as string,
    value:     row["val"]  as string,
    lens:      row["lens"] as string,
  });
}

// Load entity labels.
const entityLabels = new Map<string, string>();
for (const row of q(
  { q: [{ where: [["?e", "entity/id", "?id"], ["?e", "entity/labels", "?lbl"]] }], select: ["id", "lbl"] },
  db,
)) {
  try {
    const labels = JSON.parse(row["lbl"] as string) as Record<string, string>;
    if (labels["en"]) entityLabels.set(row["id"] as string, labels["en"]);
  } catch { /* ignore parse errors */ }
}

// Load existing worklist entries.
const existingEntries = new Map<string, WorklistEntry>(); // key: stmt_id+"|"+source_id
if (existsSync(WORKLIST_PATH)) {
  try {
    const raw = JSON.parse(readFileSync(WORKLIST_PATH, "utf-8")) as WorklistEntry[];
    for (const e of raw) existingEntries.set(`${e.stmt_id}|${e.source_id}`, e);
  } catch { /* start fresh on parse error */ }
}

const now = new Date().toISOString();
const newEntries = new Map<string, WorklistEntry>();

for (const { stmtId, sourceId } of needsSnippet) {
  const src = sourceMeta.get(sourceId);
  const stmt = stmtMeta.get(stmtId);
  if (!src || !stmt) continue;

  // Skip interpretive sources — out of scope.
  if (src.kind === "interpretive") continue;

  // Wikipedia requires revid; skip sources that lack it.
  if (src.kind === "wikipedia" && !src.revid) continue;

  const key = `${stmtId}|${sourceId}`;
  const existing = existingEntries.get(key);

  // Preserve non-pending entries as-is.
  if (existing && existing.status !== "pending") {
    newEntries.set(key, existing);
    continue;
  }

  const subject_label = entityLabels.get(stmt.subject) ?? null;
  const value_label = stmt.value.startsWith("@") ? (entityLabels.get(stmt.value) ?? null) : null;

  newEntries.set(key, {
    stmt_id: stmtId,
    subject: stmt.subject,
    subject_label,
    predicate: stmt.predicate,
    value: stmt.value,
    value_label,
    lens: stmt.lens,
    source_id: sourceId,
    source_url: src.url,
    source_revid: src.revid ?? null,
    source_kind: src.kind,
    status: "pending",
    proposed_snippet: null,
    confidence: null,
    notes: null,
    created_at: existing?.created_at ?? now,
    proposed_at: null,
    accepted_at: null,
  });
}

// Stable sort by stmt_id then source_id.
const sorted = [...newEntries.values()].sort((a, b) => {
  if (a.stmt_id < b.stmt_id) return -1;
  if (a.stmt_id > b.stmt_id) return 1;
  if (a.source_id < b.source_id) return -1;
  if (a.source_id > b.source_id) return 1;
  return 0;
});

// Atomic write via tmpfile + rename.
const tmp = WORKLIST_PATH + ".tmp";
writeFileSync(tmp, JSON.stringify(sorted, null, 2) + "\n", "utf-8");
renameSync(tmp, WORKLIST_PATH);

console.log(`Wrote ${sorted.length} entries to .snippet-worklist.json`);
const pending = sorted.filter((e) => e.status === "pending").length;
const other = sorted.length - pending;
console.log(`  ${pending} pending, ${other} with existing status`);
