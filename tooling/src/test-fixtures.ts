/**
 * Regression fixture runner.
 *
 * Each fixture is a directory under tooling/test/fixtures/ containing:
 *   lenses/<lens-id>/manifest.json
 *   lenses/<lens-id>/predicates.jsonl  (optional)
 *   lenses/<lens-id>/entities.jsonl    (optional)
 *   lenses/<lens-id>/sources.jsonl     (optional)
 *   expected.json  — array of ExpectedViolation
 *
 * ExpectedViolation: { rule: string, severity?: string, entityId?: string, predicateId?: string }
 *
 * The runner checks:
 *   - Every expected violation appears in the actual output.
 *   - No additional violations appear beyond those listed in expected.
 *
 * Run: bun run test-fixtures
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { schemaDir, __dirname as loadDirname, loadJsonl } from "./lib/load.ts";
import type {
  LoadedLensSet, LoadedLens, LoadedRecord,
  Entity, ExtensionRecord, Predicate, Source, LensManifest,
} from "./lib/load.ts";
import { validate } from "./lib/validate-lib.ts";
import { emitFacts, runDatalog, enrichViolations } from "./lib/datalog.ts";
import type { Violation } from "./lib/validate-lib.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../test/fixtures");

// ---- AJV setup ----

function loadSchema(name: string) {
  return JSON.parse(readFileSync(resolve(schemaDir, name), "utf-8"));
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateEntitySchema = ajv.compile(loadSchema("entity.schema.json"));
const validatePredicateSchema = ajv.compile(loadSchema("predicate.schema.json"));
const validateSourceSchema = ajv.compile(loadSchema("source.schema.json"));
const validateManifestSchema = ajv.compile(loadSchema("manifest.schema.json"));

// ---- Load a lens set from a specific directory ----

function loadLensSetFromDir(lensesDir: string): LoadedLensSet {
  const lensDirs = readdirSync(lensesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const manifests = new Map<string, LensManifest>();
  const manifestPaths = new Map<string, string>();

  for (const name of lensDirs) {
    const manifestPath = join(lensesDir, name, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as LensManifest;
    if (manifest.id !== name) throw new Error(`Lens dir '${name}' has manifest.id '${manifest.id}'`);
    manifests.set(name, manifest);
    manifestPaths.set(name, manifestPath);
  }

  // Toposort (simple DFS — fixtures are small)
  const visited = new Set<string>();
  const order: string[] = [];
  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const manifest = manifests.get(id);
    if (manifest) for (const dep of manifest.depends_on) visit(dep);
    order.push(id);
  }
  for (const id of manifests.keys()) visit(id);

  const lenses = new Map<string, LoadedLens>();
  for (const id of order) {
    if (!manifests.has(id)) continue; // dep not present in fixture — skip
    const manifest = manifests.get(id)!;
    const lensDir = join(lensesDir, id);
    const predicatesPath = join(lensDir, "predicates.jsonl");
    const entitiesPath = join(lensDir, "entities.jsonl");
    const sourcesPath = join(lensDir, "sources.jsonl");

    const entityDefinitions: LoadedRecord<Entity>[] = [];
    const entityExtensions: LoadedRecord<ExtensionRecord>[] = [];
    if (existsSync(entitiesPath)) {
      const rawRecords = loadJsonl<Record<string, unknown>>(entitiesPath);
      for (const { record, line, file } of rawRecords) {
        if ("extends" in record) {
          const ext = record as unknown as ExtensionRecord;
          ext.__loader_origin_lens = id;
          entityExtensions.push({ record: ext, line, file });
        } else {
          entityDefinitions.push({ record: record as unknown as Entity, line, file });
        }
      }
    }

    lenses.set(id, {
      manifest,
      manifestPath: manifestPaths.get(id)!,
      predicates: existsSync(predicatesPath) ? loadJsonl<Predicate>(predicatesPath) : [],
      entities: entityDefinitions,
      extensions: entityExtensions,
      sources: existsSync(sourcesPath) ? loadJsonl<Source>(sourcesPath) : [],
    });
  }

  return { lenses, order: order.filter(id => lenses.has(id)), cycleViolations: [] };
}

// ---- Expected violation type ----

interface ExpectedViolation {
  rule: string;
  severity?: string;
  entityId?: string;
  predicateId?: string;
  /** If specified, the number of times this violation must appear. Default: 1. */
  count?: number;
}

// ---- Run a single fixture ----

const rulesPath = resolve(loadDirname, "../../validate.ascent");

async function runFixture(fixturePath: string): Promise<{ passed: boolean; messages: string[] }> {
  const messages: string[] = [];

  const expectedPath = join(fixturePath, "expected.json");
  if (!existsSync(expectedPath)) return { passed: false, messages: ["Missing expected.json"] };

  const expected: ExpectedViolation[] = JSON.parse(readFileSync(expectedPath, "utf-8"));
  const lensesDir = join(fixturePath, "lenses");
  if (!existsSync(lensesDir)) return { passed: false, messages: ["Missing lenses/ directory"] };

  let lensSet: LoadedLensSet;
  try {
    lensSet = loadLensSetFromDir(lensesDir);
  } catch (err) {
    return { passed: false, messages: [`Failed to load fixture: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // TS structural validation
  const tsResult = validate(lensSet);

  // Datalog validation
  let datalogViolations: Violation[] = [];
  try {
    const { facts, provenance } = emitFacts(lensSet);
    const rawDlViolations = await runDatalog(facts, rulesPath);
    datalogViolations = enrichViolations(rawDlViolations, lensSet, provenance);
  } catch (err) {
    messages.push(`[datalog] ${err instanceof Error ? err.message : String(err)}`);
  }

  const allViolations = [...tsResult.violations, ...datalogViolations];

  let passed = true;

  // Check each expected violation (with multiplicity)
  for (const exp of expected) {
    const requiredCount = exp.count ?? 1;
    const matches = allViolations.filter(v =>
      v.rule === exp.rule &&
      (!exp.severity || v.severity === exp.severity) &&
      (!exp.entityId || v.entityId === exp.entityId) &&
      (!exp.predicateId || v.predicateId === exp.predicateId)
    );
    if (matches.length < requiredCount) {
      const detail = `rule=${exp.rule}${exp.entityId ? ` entityId=${exp.entityId}` : ""}${exp.predicateId ? ` predicateId=${exp.predicateId}` : ""}${exp.severity ? ` severity=${exp.severity}` : ""}`;
      if (matches.length === 0) {
        messages.push(`MISSING  ${detail}`);
      } else {
        messages.push(`TOO_FEW  ${detail} (expected ${requiredCount}, got ${matches.length})`);
      }
      passed = false;
    } else if (exp.count !== undefined && matches.length > requiredCount) {
      // Only enforce exact count when count is explicitly specified
      const detail = `rule=${exp.rule}${exp.entityId ? ` entityId=${exp.entityId}` : ""}${exp.predicateId ? ` predicateId=${exp.predicateId}` : ""}`;
      messages.push(`TOO_MANY  ${detail} (expected ${requiredCount}, got ${matches.length})`);
      passed = false;
    }
  }

  // Check for unexpected violations
  for (const v of allViolations) {
    if (v.severity === "info") continue; // info messages not checked
    const covered = expected.some(exp =>
      exp.rule === v.rule &&
      (!exp.severity || exp.severity === v.severity) &&
      (!exp.entityId || exp.entityId === v.entityId) &&
      (!exp.predicateId || exp.predicateId === v.predicateId)
    );
    if (!covered) {
      messages.push(`UNEXPECTED  rule=${v.rule} severity=${v.severity} entityId=${v.entityId}${v.predicateId !== "?" ? ` predicateId=${v.predicateId}` : ""}: ${v.message}`);
      passed = false;
    }
  }

  return { passed, messages };
}

// ---- Main ----

const fixtureDirs = readdirSync(fixturesDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

if (fixtureDirs.length === 0) {
  console.log("No fixtures found in", fixturesDir);
  process.exit(0);
}

let passed = 0;
let failed = 0;

for (const name of fixtureDirs) {
  const fixturePath = join(fixturesDir, name);
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
