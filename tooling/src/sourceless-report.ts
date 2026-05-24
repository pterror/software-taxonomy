// sourceless-report.ts — list statements with zero source links, grouped by lens then predicate.

import { loadData } from "./lib/load.js";
import { q } from "./lib/store.js";

const db = loadData();

// Collect stmt ids that have at least one src-link.
const sourcedStmts = new Set<string>();
for (const row of q(
  { q: [{ where: [["?sl", "src-link/statement", "?sid"]] }], select: ["sid"] },
  db,
)) {
  sourcedStmts.add(row["sid"] as string);
}

// Load all statements.
interface StmtInfo {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  lens: string;
}

const stmts: StmtInfo[] = [];
for (const row of q(
  { q: [{ where: [
    ["?s", "statement/id",        "?id"],
    ["?s", "statement/subject",   "?subj"],
    ["?s", "statement/predicate", "?pred"],
    ["?s", "statement/value",     "?val"],
    ["?s", "statement/lens",      "?lens"],
  ]}], select: ["id", "subj", "pred", "val", "lens"] },
  db,
)) {
  stmts.push({
    id:        row["id"]   as string,
    subject:   row["subj"] as string,
    predicate: row["pred"] as string,
    value:     row["val"]  as string,
    lens:      row["lens"] as string,
  });
}

// Filter to sourceless.
const sourceless = stmts.filter((s) => !sourcedStmts.has(s.id));

// Group by lens then predicate.
type Group = Map<string, StmtInfo[]>; // predicate → stmts
const byLens = new Map<string, Group>();
for (const s of sourceless) {
  if (!byLens.has(s.lens)) byLens.set(s.lens, new Map());
  const group = byLens.get(s.lens)!;
  if (!group.has(s.predicate)) group.set(s.predicate, []);
  group.get(s.predicate)!.push(s);
}

for (const [lens, predicates] of [...byLens.entries()].sort()) {
  console.log(`\n## lens: ${lens}`);
  for (const [predicate, rows] of [...predicates.entries()].sort()) {
    console.log(`  predicate: ${predicate}`);
    for (const s of rows) {
      console.log(`    ${s.id}  ${s.subject}  ${s.predicate}  ${s.value}`);
    }
  }
}

console.log(`\nTotal sourceless statements: ${sourceless.length}`);
