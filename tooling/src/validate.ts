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

function schemaError(file: string, line: number, id: string, msg: string) {
  console.error(`ERROR  ${file}:${line} [${id}]: ${msg}`);
  schemaErrors++;
}

// ---- Load lens set ----

const fullLensSet = loadLensSet();

// Schema-validate all records
for (const lensId of fullLensSet.order) {
  const lens = fullLensSet.lenses.get(lensId)!;

  if (!validateManifestSchema(lens.manifest)) {
    for (const err of validateManifestSchema.errors ?? []) {
      schemaError(lens.manifestPath, 0, lensId, `manifest schema: ${err.instancePath} ${err.message}`);
    }
  }

  for (const { record, file, line } of lens.predicates) {
    if (!validatePredicateSchema(record)) {
      for (const err of validatePredicateSchema.errors ?? []) {
        schemaError(file, line, (record as { id?: string }).id ?? "?",
          `predicate schema: ${err.instancePath} ${err.message}`);
      }
    }
  }

  for (const { record, file, line } of lens.sources) {
    if (!validateSourceSchema(record)) {
      for (const err of validateSourceSchema.errors ?? []) {
        schemaError(file, line, (record as { id?: string }).id ?? "?",
          `source schema: ${err.instancePath} ${err.message}`);
      }
    }
  }

  for (const { record, file, line } of lens.entities) {
    if (!validateEntitySchema(record)) {
      for (const err of validateEntitySchema.errors ?? []) {
        schemaError(file, line, (record as { id?: string }).id ?? "?",
          `entity schema: ${err.instancePath} ${err.message}`);
      }
    }
  }

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

// ---- Structural / value-type validation (TS) ----

const targetLens = lensFilter ? new Set(lensFilter) : undefined;
const tsResult = validate(fullLensSet, targetLens);

// TS handles: lens-dependency-cycle, duplicate-predicate-id, unknown-predicate,
// deprecated-predicate, alias-chain-too-long, value-type, qualifier-value-type
// Datalog handles: predicate-lens-mismatch, dangling-extension, own-entity-extension
//   (plus all graph-invariant checks)

// ---- Graph-invariant validation (Datalog) ----

const DATALOG_RULES = new Set([
  "duplicate_entity_id", "dangling_entity_ref", "dangling_source_ref",
  "domain_violation", "range_violation",
  "multi_preferred", "multi_preferred_instance_of", "no_preferred_rank",
  "cardinality_violation_min", "cardinality_violation_max",
  "deprecated_no_end_time", "end_without_start",
  "source_required_violation", "cross_lens_fictional",
  "qualifier_unknown_predicate", "qualifier_dangling_ref",
  "alias_self_reference", "alias_cycle",
]);

const rulesPath = resolve(__dirname, "../../validate.ascent");
const { facts, provenance } = emitFacts(fullLensSet);
// provenance is now ProvenanceMaps: { stmt, predicate, lens }

let datalogViolations: import("./lib/validate-lib.ts").Violation[] = [];
try {
  const rawDlViolations = await runDatalog(facts, rulesPath);
  datalogViolations = enrichViolations(rawDlViolations, fullLensSet, provenance);
} catch (err) {
  console.error(`[datalog] Warning: Datalog validator failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error("[datalog] Continuing with TS validator only.");
}

// ---- Merge and report ----

const allViolations = [...tsResult.violations, ...datalogViolations]
  .sort((a, b) => {
    const sevOrder = { error: 0, warning: 1, info: 2 };
    const sA = sevOrder[a.severity] ?? 3;
    const sB = sevOrder[b.severity] ?? 3;
    if (sA !== sB) return sA - sB;
    return (a.file || "").localeCompare(b.file || "") || (a.line || 0) - (b.line || 0);
  });

for (const v of allViolations) {
  const prefix = v.severity === "error" ? "ERROR " : v.severity === "warning" ? "WARN  " : "INFO  ";
  const loc = v.file && v.line ? `${v.file}:${v.line}` : v.file || "(unknown)";
  const logFn = v.severity === "error" ? console.error : v.severity === "warning" ? console.warn : console.info;
  logFn(`${prefix} [${v.lens}] ${loc} [${v.entityId}] {${v.predicateId}} ${v.rule}: ${v.message}`);
}

// Merge Datalog violations into per-lens summaries
const dlByLens = new Map<string, { errors: number; warnings: number }>();
for (const v of datalogViolations) {
  if (v.severity === "info") continue;
  const entry = dlByLens.get(v.lens) ?? { errors: 0, warnings: 0 };
  if (v.severity === "error") entry.errors++;
  else entry.warnings++;
  dlByLens.set(v.lens, entry);
}

console.log("\n--- Validation Summary ---");
let totalEntities = 0;
let totalPredicates = 0;
let totalSources = 0;

for (const s of tsResult.summaries) {
  const show = !targetLens || targetLens.has(s.lensId);
  if (!show) continue;
  const dl = dlByLens.get(s.lensId) ?? { errors: 0, warnings: 0 };
  const errors = s.errors + dl.errors;
  const warnings = s.warnings + dl.warnings;
  console.log(
    `  ${s.lensId.padEnd(20)} entities: ${String(s.entities).padStart(3)}  predicates: ${String(s.predicates).padStart(3)}  sources: ${String(s.sources).padStart(3)}  errors: ${errors}  warnings: ${warnings}`
  );
  totalEntities += s.entities;
  totalPredicates += s.predicates;
  totalSources += s.sources;
}

const totalErrors = allViolations.filter(v => v.severity === "error").length;
const totalWarnings = allViolations.filter(v => v.severity === "warning").length;

console.log(`\nTotal: ${totalEntities} entities, ${totalPredicates} predicates, ${totalSources} sources`);
console.log(`${totalErrors} error(s), ${totalWarnings} warning(s).`);

if (totalErrors > 0) {
  process.exit(1);
}
