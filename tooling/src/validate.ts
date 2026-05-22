import { readFileSync } from "fs";
import { resolve } from "path";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { loadEntities, loadPredicates, loadSources, schemaDir, dataDir, Entity } from "./lib/load.ts";

function loadSchema(name: string) {
  return JSON.parse(readFileSync(resolve(schemaDir, name), "utf-8"));
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const entitySchema = loadSchema("entity.schema.json");
const predicateSchema = loadSchema("predicate.schema.json");
const sourceSchema = loadSchema("source.schema.json");

const validateEntity = ajv.compile(entitySchema);
const validatePredicate = ajv.compile(predicateSchema);
const validateSource = ajv.compile(sourceSchema);

let errors = 0;
let warnings = 0;

function error(file: string, line: number, entityId: string, msg: string) {
  console.error(`ERROR  ${file}:${line} [${entityId}]: ${msg}`);
  errors++;
}

function warn(file: string, line: number, entityId: string, msg: string) {
  console.warn(`WARN   ${file}:${line} [${entityId}]: ${msg}`);
  warnings++;
}

const entityFile = resolve(dataDir, "entities.jsonl");
const predicateFile = resolve(dataDir, "predicates.jsonl");
const sourcesFile = resolve(dataDir, "sources.jsonl");

const entityRecords = loadEntities();
const predicateRecords = loadPredicates();
const sourceRecords = loadSources();

const entityIds = new Set<string>();
const predicateIds = new Set<string>();
const sourceIds = new Set<string>();

// Pass 1: schema-validate all records and collect ids
for (const { record, line } of predicateRecords) {
  if (!validatePredicate(record)) {
    for (const err of validatePredicate.errors ?? []) {
      error(predicateFile, line, (record as { id?: string }).id ?? "?", `schema: ${err.instancePath} ${err.message}`);
    }
  } else {
    predicateIds.add(record.id);
  }
}

for (const { record, line } of sourceRecords) {
  if (!validateSource(record)) {
    for (const err of validateSource.errors ?? []) {
      error(sourcesFile, line, (record as { id?: string }).id ?? "?", `schema: ${err.instancePath} ${err.message}`);
    }
  } else {
    sourceIds.add(record.id);
  }
}

// Collect entity ids first so forward refs work
for (const { record } of entityRecords) {
  entityIds.add(record.id);
}

// Pass 2: schema-validate entities and check integrity
for (const { record, line } of entityRecords) {
  if (!validateEntity(record)) {
    for (const err of validateEntity.errors ?? []) {
      error(entityFile, line, (record as { id?: string }).id ?? "?", `schema: ${err.instancePath} ${err.message}`);
    }
    continue;
  }

  const entity = record as Entity;

  // Determine if this is a class entity (to relax source warnings)
  const instanceOfValues = (entity.statements["instance_of"] ?? []).map((e) => e.value);
  const isClassEntity = instanceOfValues.includes("@class");

  for (const [predicate, entries] of Object.entries(entity.statements)) {
    // Warn on unknown predicates
    if (!predicateIds.has(predicate)) {
      warn(entityFile, line, entity.id, `unknown predicate '${predicate}'`);
    }

    for (const entry of entries) {
      // Resolve entity references in value
      if (typeof entry.value === "string" && entry.value.startsWith("@")) {
        const refId = entry.value.slice(1);
        if (!entityIds.has(refId)) {
          error(entityFile, line, entity.id, `dangling entity ref '${entry.value}' in predicate '${predicate}'`);
        }
      }

      // Resolve source reference
      if (entry.source != null && !sourceIds.has(entry.source)) {
        error(entityFile, line, entity.id, `dangling source ref '${entry.source}' in predicate '${predicate}'`);
      }

      // Warn on missing source, except structural predicates on class entities
      const isStructuralOnClass = isClassEntity && (predicate === "instance_of" || predicate === "subclass_of");
      if (entry.source == null && !isStructuralOnClass) {
        warn(entityFile, line, entity.id, `no source on predicate '${predicate}'`);
      }

      // Resolve qualifier entity refs
      if (entry.qualifiers != null) {
        for (const [qPred, qVal] of Object.entries(entry.qualifiers)) {
          if (typeof qVal === "string" && qVal.startsWith("@")) {
            const refId = qVal.slice(1);
            if (!entityIds.has(refId)) {
              error(entityFile, line, entity.id, `dangling entity ref '${qVal}' in qualifier '${qPred}' on predicate '${predicate}'`);
            }
          }
        }
      }
    }
  }
}

console.log(
  `\nValidation complete: ${entityRecords.length} entities, ${predicateRecords.length} predicates, ${sourceRecords.length} sources.`
);
console.log(`${errors} error(s), ${warnings} warning(s).`);

if (errors > 0) {
  process.exit(1);
}
