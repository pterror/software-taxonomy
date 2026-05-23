import { readFileSync } from "fs";
import { resolve } from "path";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { loadLensSet, schemaDir, __dirname } from "./lib/load.ts";
import { validate } from "./lib/validate-lib.ts";
import { emitFacts, runDatalog, enrichViolations } from "./lib/datalog.ts";

// ---- CLI args ----

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const lensArg = getArg("--lens");
const lensFilter = lensArg ? lensArg.split(",").map((s) => s.trim()) : undefined;

// ---- Schema validation ----

function loadSchema(name: string) {
  return JSON.parse(readFileSync(resolve(schemaDir, name), "utf-8"));
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const entitySchema = loadSchema("entity.schema.json");
const predicateSchema = loadSchema("predicate.schema.json");
const sourceSchema = loadSchema("source.schema.json");
const manifestSchema = loadSchema("manifest.schema.json");

const validateEntitySchema = ajv.compile(entitySchema);
const validatePredicateSchema = ajv.compile(predicateSchema);
const validateSourceSchema = ajv.compile(sourceSchema);
const validateManifestSchema = ajv.compile(manifestSchema);

let schemaErrors = 0;
let schemaWarnings = 0;

function schemaError(file: string, line: number, id: string, msg: string) {
  console.error(`ERROR  ${file}:${line} [${id}]: ${msg}`);
  schemaErrors++;
}

// ---- Load lens set ----

// Always load ALL lenses for transitive checks; filter only controls which to report
const fullLensSet = loadLensSet();

// Schema-validate all records
for (const lensId of fullLensSet.order) {
  const lens = fullLensSet.lenses.get(lensId)!;

  // Validate manifest
  if (!validateManifestSchema(lens.manifest)) {
    for (const err of validateManifestSchema.errors ?? []) {
      schemaError(lens.manifestPath, 0, lensId, `manifest schema: ${err.instancePath} ${err.message}`);
    }
  }

  // Validate predicates
  for (const { record, file, line } of lens.predicates) {
    if (!validatePredicateSchema(record)) {
      for (const err of validatePredicateSchema.errors ?? []) {
        schemaError(file, line, (record as { id?: string }).id ?? "?",
          `predicate schema: ${err.instancePath} ${err.message}`);
      }
    }
  }

  // Validate sources
  for (const { record, file, line } of lens.sources) {
    if (!validateSourceSchema(record)) {
      for (const err of validateSourceSchema.errors ?? []) {
        schemaError(file, line, (record as { id?: string }).id ?? "?",
          `source schema: ${err.instancePath} ${err.message}`);
      }
    }
  }

  // Validate entities (definition records)
  for (const { record, file, line } of lens.entities) {
    if (!validateEntitySchema(record)) {
      for (const err of validateEntitySchema.errors ?? []) {
        schemaError(file, line, (record as { id?: string }).id ?? "?",
          `entity schema: ${err.instancePath} ${err.message}`);
      }
    }
  }

  // Validate extension records (schema parity with definition records)
  // Strip the loader-injected __loader_origin_lens field before schema validation
  for (const { record, file, line } of lens.extensions) {
    const { __loader_origin_lens: _ignored, ...recordForValidation } = record as Record<string, unknown>;
    if (!validateEntitySchema(recordForValidation)) {
      for (const err of validateEntitySchema.errors ?? []) {
        const extId = (record as { extends?: string }).extends ?? "?";
        schemaError(file, line, extId,
          `extension schema: ${err.instancePath} ${err.message}`);
      }
    }
  }
}

// ---- Duplicate source id detection ----
const seenSourceIds = new Map<string, { file: string; line: number; lens: string }>();
for (const lensId of fullLensSet.order) {
  const lens = fullLensSet.lenses.get(lensId)!;
  for (const { record, file, line } of lens.sources) {
    const src = record as { id?: string };
    const id = src.id ?? "";
    if (id) {
      const prev = seenSourceIds.get(id);
      if (prev) {
        console.error(`ERROR  ${file}:${line} [${id}]: duplicate source id (previously seen at ${prev.file}:${prev.line} in lens '${prev.lens}')`);
        schemaErrors++;
      } else {
        seenSourceIds.set(id, { file, line, lens: lensId });
      }
    }
  }
}

if (schemaErrors > 0) {
  console.error(`\n${schemaErrors} schema error(s) found. Aborting semantic validation.`);
  process.exit(1);
}

// ---- Semantic validation (TS validator) ----

const targetLens = lensFilter ? new Set(lensFilter) : undefined;
const result = validate(fullLensSet, targetLens);

// ---- Datalog validator (runs in parallel for sanity-checking) ----

const rulesPath = resolve(__dirname, "../../validate.ascent");
const { facts, provenance } = emitFacts(fullLensSet);

let datalogViolations: import("./lib/validate-lib.ts").Violation[] = [];
try {
  const rawDlViolations = await runDatalog(facts, rulesPath);
  datalogViolations = enrichViolations(rawDlViolations, fullLensSet, provenance);

  // ---- Sanity check: compare migrated checks between TS and Datalog ----
  // Checks currently in Datalog: duplicate_entity_id, dangling_entity_ref (dangling_source_ref stub)
  const MIGRATED_RULES = new Set(["duplicate_entity_id", "dangling_entity_ref", "dangling_source_ref"]);

  const tsForMigrated = result.violations.filter(v => MIGRATED_RULES.has(v.rule));
  const dlForMigrated = datalogViolations.filter(v => MIGRATED_RULES.has(v.rule));

  if (tsForMigrated.length !== dlForMigrated.length) {
    console.error(`\n[sanity] DRIFT: TS found ${tsForMigrated.length} violations for migrated rules, Datalog found ${dlForMigrated.length}`);
    if (tsForMigrated.length > 0) {
      console.error("[sanity] TS violations:");
      for (const v of tsForMigrated) console.error(`  ${v.rule} ${v.entityId} ${v.predicateId}`);
    }
    if (dlForMigrated.length > 0) {
      console.error("[sanity] Datalog violations:");
      for (const v of dlForMigrated) console.error(`  ${v.rule} ${v.entityId} ${v.predicateId}`);
    }
  }
} catch (err) {
  console.error(`[datalog] Warning: Datalog validator failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error("[datalog] Continuing with TS validator only.");
}

// ---- Print violations (TS validator is authoritative for now) ----

for (const v of result.violations) {
  const prefix = v.severity === "error" ? "ERROR " : v.severity === "warning" ? "WARN  " : "INFO  ";
  const loc = v.file && v.line ? `${v.file}:${v.line}` : v.file || "(unknown)";
  const logFn = v.severity === "error" ? console.error : v.severity === "warning" ? console.warn : console.info;
  logFn(`${prefix} [${v.lens}] ${loc} [${v.entityId}] {${v.predicateId}} ${v.rule}: ${v.message}`);
}

// Print summary
console.log("\n--- Validation Summary ---");
let totalEntities = 0;
let totalPredicates = 0;
let totalSources = 0;

for (const s of result.summaries) {
  const show = !targetLens || targetLens.has(s.lensId);
  if (!show) continue;
  console.log(
    `  ${s.lensId.padEnd(20)} entities: ${String(s.entities).padStart(3)}  predicates: ${String(s.predicates).padStart(3)}  sources: ${String(s.sources).padStart(3)}  errors: ${s.errors}  warnings: ${s.warnings}`
  );
  totalEntities += s.entities;
  totalPredicates += s.predicates;
  totalSources += s.sources;
}

console.log(`\nTotal: ${totalEntities} entities, ${totalPredicates} predicates, ${totalSources} sources`);
console.log(`${result.totalErrors} error(s), ${result.totalWarnings} warning(s).`);

if (result.totalErrors > 0) {
  process.exit(1);
}
