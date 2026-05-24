// snippet-todo.ts — list every statement whose sources array is empty OR has a source-link
// without a snippet. Output one line per statement; summary count at the end.

import { loadData } from "./lib/load.js";
import { q } from "./lib/store.js";

const db = loadData();

// Collect all stmt ids that have at least one src-link with a snippet.
const snippetedStmts = new Set<string>();
for (const row of q({ q: [{ where: [["?sl", "src-link/statement", "?sid"], ["?sl", "src-link/snippet", "?sn"]] }], select: ["sid"] }, db)) {
  snippetedStmts.add(row["sid"] as string);
}

// Collect all stmt ids that have at least one src-link (even without snippet).
const sourcedStmts = new Set<string>();
for (const row of q({ q: [{ where: [["?sl", "src-link/statement", "?sid"]] }], select: ["sid"] }, db)) {
  sourcedStmts.add(row["sid"] as string);
}

// Load all statements with subject, predicate, value, lens.
interface StmtInfo {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  lens: string;
}

const stmtRows = q(
  { q: [{ where: [
    ["?s", "statement/id", "?id"],
    ["?s", "statement/subject", "?subj"],
    ["?s", "statement/predicate", "?pred"],
    ["?s", "statement/value", "?val"],
    ["?s", "statement/lens", "?lens"],
  ]}], select: ["id", "subj", "pred", "val", "lens"] },
  db,
);

const stmts: StmtInfo[] = [];
for (const row of stmtRows) {
  stmts.push({
    id:        row["id"]   as string,
    subject:   row["subj"] as string,
    predicate: row["pred"] as string,
    value:     row["val"]  as string,
    lens:      row["lens"] as string,
  });
}

// A statement needs a snippet if:
//   (a) it has no sources at all, OR
//   (b) it has sources but none of them has a snippet.
const todo = stmts.filter((s) => !snippetedStmts.has(s.id));

// Sort by lens then subject.
todo.sort((a, b) => {
  if (a.lens < b.lens) return -1;
  if (a.lens > b.lens) return 1;
  if (a.subject < b.subject) return -1;
  if (a.subject > b.subject) return 1;
  return 0;
});

for (const s of todo) {
  console.log(`${s.id}  ${s.subject}  ${s.predicate}  ${s.value}  (lens=${s.lens})`);
}

console.log(`\nTotal statements needing snippet: ${todo.length}`);
