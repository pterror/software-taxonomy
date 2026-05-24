// repl.ts — interactive REPL for querying the data store.
//
// Each line is parsed as JSON, treated as a QuerySpec, fed to q(), results pretty-printed.
// Special commands: :help, :count, :exit

import { createInterface } from "node:readline/promises";
import { loadData } from "./lib/load.js";
import { q, datumCount } from "./lib/store.js";

const db = loadData();

console.log(`data store loaded. ${datumCount(db)} datoms.`);
console.log('Type a JSON QuerySpec, or :help, :count, :exit.');

const rl = createInterface({
  input:  process.stdin,
  output: process.stdout,
});

function printHelp(): void {
  console.log(
    "Commands:\n" +
    "  :help    show this message\n" +
    "  :count   print total datom count\n" +
    "  :exit    quit\n\n" +
    "Query format (JSON):\n" +
    '  { "q": [{ "where": [["?e", "entity/id", "?v"]] }], "select": ["v"] }\n' +
    "  Results are a Set<Record<string,unknown>>."
  );
}

for (;;) {
  const line = await rl.question("> ");
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (trimmed === ":exit") { rl.close(); break; }
  if (trimmed === ":help")  { printHelp(); continue; }
  if (trimmed === ":count") { console.log(`Datoms: ${datumCount(db)}`); continue; }

  try {
    const spec = JSON.parse(trimmed);
    const results = q(spec, db);
    console.log(JSON.stringify([...results], null, 2));
    console.log(`(${results.size} result(s))`);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
  }
}
