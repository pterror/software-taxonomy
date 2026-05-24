// New fixture test runner for fixtures2/.
// Each fixture is a data2-style directory with an expected.json.
// Runs validate2 rules against each fixture and checks violations.
//
// Run: bun run test-fixtures2

import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadData2 } from "./lib/load2.js";
import { runAllRules } from "./lib/rules2.js";
import type { Violation } from "./lib/violations2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures2Dir = resolve(__dirname, "../test/fixtures2");

interface ExpectedViolation {
  rule: string;
  severity?: string;
  entityId?: string;
  predicateId?: string;
  count?: number;
}

async function runFixture(fixturePath: string): Promise<{ passed: boolean; messages: string[] }> {
  const messages: string[] = [];

  const expectedPath = join(fixturePath, "expected.json");
  if (!existsSync(expectedPath)) return { passed: false, messages: ["Missing expected.json"] };

  const expected: ExpectedViolation[] = JSON.parse(readFileSync(expectedPath, "utf-8"));

  let db;
  try {
    db = loadData2(fixturePath);
  } catch (err) {
    return { passed: false, messages: [`Failed to load fixture: ${err instanceof Error ? err.message : String(err)}`] };
  }

  let allViolations: Violation[];
  try {
    allViolations = runAllRules(db);
  } catch (err) {
    return { passed: false, messages: [`Rules threw: ${err instanceof Error ? err.message : String(err)}`] };
  }

  let passed = true;

  // Check each expected violation (with multiplicity)
  for (const exp of expected) {
    const requiredCount = exp.count ?? 1;
    const matches = allViolations.filter(v =>
      v.rule === exp.rule &&
      (!exp.severity || v.severity === exp.severity) &&
      (!exp.entityId || v.subject === exp.entityId) &&
      (!exp.predicateId || v.predicate === exp.predicateId)
    );
    if (matches.length < requiredCount) {
      const detail = `rule=${exp.rule}${exp.entityId ? ` entityId=${exp.entityId}` : ""}${exp.predicateId ? ` predicateId=${exp.predicateId}` : ""}${exp.severity ? ` severity=${exp.severity}` : ""}`;
      messages.push(matches.length === 0 ? `MISSING  ${detail}` : `TOO_FEW  ${detail} (expected ${requiredCount}, got ${matches.length})`);
      passed = false;
    } else if (exp.count !== undefined && matches.length > requiredCount) {
      const detail = `rule=${exp.rule}${exp.entityId ? ` entityId=${exp.entityId}` : ""}${exp.predicateId ? ` predicateId=${exp.predicateId}` : ""}`;
      messages.push(`TOO_MANY  ${detail} (expected ${requiredCount}, got ${matches.length})`);
      passed = false;
    }
  }

  // Check for unexpected violations
  for (const v of allViolations) {
    if (v.severity === "info") continue;
    const covered = expected.some(exp =>
      exp.rule === v.rule &&
      (!exp.severity || exp.severity === v.severity) &&
      (!exp.entityId || exp.entityId === v.subject) &&
      (!exp.predicateId || exp.predicateId === v.predicate)
    );
    if (!covered) {
      messages.push(`UNEXPECTED  rule=${v.rule} severity=${v.severity} subject=${v.subject ?? "?"}${v.predicate ? ` predicate=${v.predicate}` : ""}: ${v.message}`);
      passed = false;
    }
  }

  return { passed, messages };
}

if (!existsSync(fixtures2Dir)) {
  console.log("No fixtures2 directory found at", fixtures2Dir);
  process.exit(0);
}

const fixtureDirs = readdirSync(fixtures2Dir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

if (fixtureDirs.length === 0) {
  console.log("No fixtures found in", fixtures2Dir);
  process.exit(0);
}

let passed = 0;
let failed = 0;

for (const name of fixtureDirs) {
  const fixturePath = join(fixtures2Dir, name);
  const result = await runFixture(fixturePath);
  const status = result.passed ? "PASS" : "FAIL";
  console.log(`  ${status}  ${name}`);
  for (const msg of result.messages) {
    console.log(`       ${msg}`);
  }
  if (result.passed) passed++;
  else failed++;
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
