// Converts a single old-format fixture directory to a fixtures2/-style directory.
//
// Usage: bun src/convert-fixture.ts <fixture-dir> <output-dir>
//
// Produces:
//   <output-dir>/         — data2-style converted data
//   <output-dir>/expected.json  — migrated from original, with updated ids and dropped rules

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { convertLenses, readJsonl, type OldPredicate } from "./lib/convert-lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const [fixtureDir, outputDir] = process.argv.slice(2);
if (!fixtureDir || !outputDir) {
  console.error("Usage: bun src/convert-fixture.ts <fixture-dir> <output-dir>");
  process.exit(1);
}

const fixturePath = resolve(fixtureDir);
const outputPath = resolve(outputDir);

const lensesDir = join(fixturePath, "lenses");
if (!existsSync(lensesDir)) {
  console.error(`No lenses/ dir at ${lensesDir}`); process.exit(1);
}

const fixtureName = fixturePath.split("/").pop() ?? "fixture";

// Convert the data
convertLenses({ lensesDir, outDir: outputPath, seed: fixtureName });

// --- Migrate expected.json ---

// Rules that only exist in the TS validator (validate-lib.ts), not in rules2.
// These cannot appear in fixtures2 expected output.
const TS_ONLY_RULES = new Set([
  "alias-chain-too-long",
  "unknown-predicate",
  "value-type",
  "deprecated-predicate",
  "duplicate-predicate-id",
  "lens-dependency-cycle",
  "qualifier-value-type",
  "alias-usage",
]);

// Rules that cannot fire in data2/ because the underlying data structure changed.
const MERGED_AWAY_RULES = new Set([
  "dangling_extension",
  "own_entity_extension",
]);

// Rules that cannot fire in data2/ because entity id uniqueness is enforced
// at conversion time (convert.ts merges definitions).
const DATA2_NO_OP_RULES = new Set([
  "duplicate_entity_id",
]);

// Build predicate slug → "@lens:slug" map from fixture predicates
const predMap = new Map<string, string>(); // bare slug → @lens:slug
const lensDirs = readdirSync(lensesDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);
for (const lensId of lensDirs) {
  const preds = readJsonl<OldPredicate>(join(lensesDir, lensId, "predicates.jsonl"));
  for (const pred of preds) {
    predMap.set(pred.id, `@${lensId}:${pred.id}`);
  }
}

interface OldExpectedViolation {
  rule: string;
  severity?: string;
  entityId?: string;
  predicateId?: string;
  count?: number;
}

const expectedSrc = join(fixturePath, "expected.json");
let expected: OldExpectedViolation[] = [];
if (existsSync(expectedSrc)) {
  expected = JSON.parse(readFileSync(expectedSrc, "utf-8")) as OldExpectedViolation[];
}

// Migrate: update ids and drop non-applicable rules
const migratedExpected = expected
  .filter(v => !TS_ONLY_RULES.has(v.rule) && !MERGED_AWAY_RULES.has(v.rule) && !DATA2_NO_OP_RULES.has(v.rule))
  .map(v => {
    const out: OldExpectedViolation = { ...v };
    // Qualify entity id: "ns:slug" → "@ns:slug"
    if (out.entityId && !out.entityId.startsWith("@")) {
      out.entityId = `@${out.entityId}`;
    }
    // Qualify predicate id: bare slug → "@lens:slug"
    if (out.predicateId && !out.predicateId.startsWith("@")) {
      const qualified = predMap.get(out.predicateId);
      if (qualified) out.predicateId = qualified;
    }
    return out;
  });

mkdirSync(outputPath, { recursive: true });
writeFileSync(join(outputPath, "expected.json"), JSON.stringify(migratedExpected, null, 2) + "\n");

console.log(`Converted ${fixtureName} → ${outputPath} (${migratedExpected.length} expected violations)`);
