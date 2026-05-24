// snippet-status.ts — print worklist counts grouped by status, lens, source_kind.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { repoRoot } from "./lib/entity-file.js";
import type { WorklistEntry } from "./snippet-worklist.js";

const WORKLIST_PATH = join(repoRoot, ".snippet-worklist.json");

if (!existsSync(WORKLIST_PATH)) {
  console.log("No worklist found. Run: bun run snippet-worklist");
  process.exit(0);
}

const entries: WorklistEntry[] = JSON.parse(readFileSync(WORKLIST_PATH, "utf-8"));

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

const STATUSES = ["pending", "proposed", "accepted", "rejected", "unsupported"] as const;

console.log(`Total entries: ${entries.length}\n`);

// By status
console.log("By status:");
const byStatus = countBy(entries, (e) => e.status);
for (const s of STATUSES) {
  const n = byStatus.get(s) ?? 0;
  if (n > 0) console.log(`  ${s.padEnd(12)} ${n}`);
}

// By lens
console.log("\nBy lens:");
const byLens = countBy(entries, (e) => e.lens);
for (const [lens, count] of [...byLens.entries()].sort()) {
  console.log(`  ${lens.padEnd(20)} ${count}`);
}

// By source_kind
console.log("\nBy source kind:");
const byKind = countBy(entries, (e) => e.source_kind);
for (const [kind, count] of [...byKind.entries()].sort()) {
  console.log(`  ${kind.padEnd(16)} ${count}`);
}
