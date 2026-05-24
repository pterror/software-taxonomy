// review-snippets.ts — interactive CLI to review proposed snippets and promote to entity files.
//
// For each entry with status=proposed:
//   [a]ccept / [e]dit / [r]eject / [s]kip / [q]uit

import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { repoRoot, readEntityFile, writeEntityFile } from "./lib/entity-file.js";
import { fetchSourceText } from "./lib/source-fetch.js";
import type { WorklistEntry } from "./snippet-worklist.js";

const WORKLIST_PATH = join(repoRoot, ".snippet-worklist.json");

if (!existsSync(WORKLIST_PATH)) {
  console.error("No worklist found. Run: bun run snippet-worklist");
  process.exit(1);
}

const entries: WorklistEntry[] = JSON.parse(readFileSync(WORKLIST_PATH, "utf-8"));

const proposed = entries.filter((e) => e.status === "proposed");
if (proposed.length === 0) {
  console.log("No proposed entries to review. Run /propose-snippets to generate proposals.");
  process.exit(0);
}

console.log(`Found ${proposed.length} proposed entries to review.\n`);

function saveWorklist(): void {
  const tmp = WORKLIST_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", "utf-8");
  renameSync(tmp, WORKLIST_PATH);
}

async function verifyAndWrite(entry: WorklistEntry, snippet: string): Promise<boolean> {
  let text: string;
  try {
    text = await fetchSourceText(entry.source_id, {
      kind: entry.source_kind,
      url: entry.source_url,
      revid: entry.source_revid ?? undefined,
    });
  } catch (err) {
    console.error(`  ERROR fetching source: ${(err as Error).message}`);
    return false;
  }

  if (!text.includes(snippet)) {
    console.error(`  VERIFICATION FAILED: snippet not found verbatim in fetched source text.`);
    return false;
  }

  // Write snippet into entity file.
  const entity = readEntityFile(entry.subject);
  if (!entity) {
    console.error(`  ERROR: entity file not found for ${entry.subject}`);
    return false;
  }

  const stmt = entity.statements.find((s) => s.id === entry.stmt_id);
  if (!stmt) {
    console.error(`  ERROR: statement ${entry.stmt_id} not found in entity file`);
    return false;
  }

  if (!stmt.sources) {
    console.error(`  ERROR: statement has no sources array`);
    return false;
  }

  const srcLink = stmt.sources.find((s) => s.id === entry.source_id);
  if (!srcLink) {
    console.error(`  ERROR: source link ${entry.source_id} not found in statement`);
    return false;
  }

  srcLink.snippet = snippet;
  writeEntityFile(entry.subject, entity);
  return true;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

for (const entry of proposed) {
  console.log("─".repeat(72));
  console.log(`stmt_id:   ${entry.stmt_id}`);
  console.log(`subject:   ${entry.subject}${entry.subject_label ? ` (${entry.subject_label})` : ""}`);
  console.log(`predicate: ${entry.predicate}`);
  console.log(`value:     ${entry.value}${entry.value_label ? ` (${entry.value_label})` : ""}`);
  console.log(`lens:      ${entry.lens}`);
  console.log(`source:    ${entry.source_id}`);
  console.log(`url:       ${entry.source_url}`);
  if (entry.source_revid) console.log(`revid:     ${entry.source_revid}`);
  console.log(`confidence: ${entry.confidence ?? "?"}`);
  if (entry.notes) console.log(`notes:     ${entry.notes}`);
  console.log(`\nSnippet:\n  "${entry.proposed_snippet}"\n`);

  let snippet = entry.proposed_snippet ?? "";
  let done = false;

  while (!done) {
    const answer = (await rl.question("[a]ccept / [e]dit / [r]eject / [s]kip / [q]uit > ")).trim().toLowerCase();

    if (answer === "q") {
      saveWorklist();
      console.log("\nWorklist saved. Exiting.");
      rl.close();
      process.exit(0);
    } else if (answer === "s") {
      done = true;
    } else if (answer === "r") {
      entry.status = "rejected";
      saveWorklist();
      console.log("  Rejected.");
      done = true;
    } else if (answer === "a") {
      const ok = await verifyAndWrite(entry, snippet);
      if (ok) {
        entry.status = "accepted";
        entry.accepted_at = new Date().toISOString();
        saveWorklist();
        console.log("  Accepted and written to entity file.");
        done = true;
      }
      // If not ok, loop back to prompt.
    } else if (answer === "e") {
      const newSnippet = (await rl.question("  New snippet: ")).trim();
      if (newSnippet) {
        snippet = newSnippet;
        entry.proposed_snippet = snippet;
        console.log(`  Updated snippet: "${snippet}"`);
      }
    } else {
      console.log("  Unknown command. Use a/e/r/s/q.");
    }
  }
}

rl.close();
saveWorklist();
console.log("\nAll proposed entries reviewed. Worklist saved.");
