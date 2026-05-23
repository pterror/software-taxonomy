import { readFileSync } from "fs";
import { resolve } from "path";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { loadLensSet, schemaDir } from "./lib/load.ts";
import { validate } from "./lib/validate-lib.ts";

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

  // Validate entities
  for (const { record, file, line } of lens.entities) {
    if (!validateEntitySchema(record)) {
      for (const err of validateEntitySchema.errors ?? []) {
        schemaError(file, line, (record as { id?: string }).id ?? "?",
          `entity schema: ${err.instancePath} ${err.message}`);
      }
    }
  }
}

if (schemaErrors > 0) {
  console.error(`\n${schemaErrors} schema error(s) found. Aborting semantic validation.`);
  process.exit(1);
}

// ---- Semantic validation ----

const targetLens = lensFilter ? new Set(lensFilter) : undefined;
const result = validate(fullLensSet, targetLens);

// Print violations
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
