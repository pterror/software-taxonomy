// new-statement.ts — interactive CLI to append a statement to a data2 entity file.
//
// Usage: bun run new-statement <subject> <predicate> <value> --lens <lens>
//
// Prompts for:
//   - source id (or blank to omit)
//   - snippet (or blank to omit; only prompted if source id provided)
//
// Aborts if subject entity or predicate does not exist in data2.

import { createInterface } from "node:readline/promises";
import { loadData2 } from "./lib/load2.js";
import { q } from "./lib/store.js";
import {
  readEntityFile,
  writeEntityFile,
  collectExistingStmtIds,
  freshStmtId,
  type Statement,
} from "./lib/entity-file.js";

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const [subjectRaw, predicateRaw, valueRaw] = args;
const lensArg = getArg("--lens");

if (!subjectRaw || !predicateRaw || valueRaw === undefined || !lensArg) {
  console.error("Usage: bun run new-statement <subject> <predicate> <value> --lens <lens>");
  process.exit(1);
}

const subject   = subjectRaw.startsWith("@")   ? subjectRaw   : `@${subjectRaw}`;
const predicate = predicateRaw.startsWith("@") ? predicateRaw : `@${predicateRaw}`;

const db = loadData2();

// Verify subject exists
const entityRows = q({ q: [{ where: [["?e", "entity/id", "?id"]] }], select: ["id"] }, db);
const entityIds = new Set<string>([...entityRows].map((r) => r["id"] as string));
if (!entityIds.has(subject)) {
  console.error(`Subject entity '${subject}' not found in data2.`);
  process.exit(1);
}

// Verify predicate exists
const predRows = q({ q: [{ where: [["?e", "predicate/id", "?id"]] }], select: ["id"] }, db);
const predIds = new Set<string>([...predRows].map((r) => r["id"] as string));
if (!predIds.has(predicate)) {
  console.error(`Predicate '${predicate}' not found in data2.`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

const sourceId = (await rl.question("Source id (blank to omit): ")).trim();
let snippet: string | undefined;
if (sourceId) {
  const s = (await rl.question("Snippet (blank to omit): ")).trim();
  if (s) snippet = s;
}
rl.close();

const existing = collectExistingStmtIds();
const stmtId   = freshStmtId(existing);

const sources: Statement["sources"] = sourceId
  ? [snippet !== undefined ? { id: sourceId, snippet } : { id: sourceId }]
  : [];

const newStmt: Statement = {
  id:        stmtId,
  predicate,
  value:     valueRaw,
  lens:      lensArg,
  sources,
};

const entityFile = readEntityFile(subject);
if (!entityFile) {
  console.error(`Entity file for '${subject}' not found on disk.`);
  process.exit(1);
}

entityFile.statements.push(newStmt);
writeEntityFile(subject, entityFile);

console.log(`Added statement ${stmtId} to ${subject}.`);
