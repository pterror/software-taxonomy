import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { loadJsonl } from "./lib/load.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(__dirname, "../../schema");
const dataDir = resolve(__dirname, "../../data");

function loadSchema(name: string) {
  return JSON.parse(readFileSync(resolve(schemaDir, name), "utf-8"));
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const cladeSchema = loadSchema("clade.schema.json");
const speciesSchema = loadSchema("species.schema.json");
const edgeSchema = loadSchema("edge.schema.json");
const sourceSchema = loadSchema("source.schema.json");

const validateClade = ajv.compile(cladeSchema);
const validateSpecies = ajv.compile(speciesSchema);
const validateEdge = ajv.compile(edgeSchema);
const validateSource = ajv.compile(sourceSchema);

let errors = 0;
let warnings = 0;

function error(file: string, line: number, msg: string) {
  console.error(`ERROR  ${file}:${line}: ${msg}`);
  errors++;
}

function warn(file: string, line: number, msg: string) {
  console.warn(`WARN   ${file}:${line}: ${msg}`);
  warnings++;
}

const cladeFile = resolve(dataDir, "clades.jsonl");
const speciesFile = resolve(dataDir, "species.jsonl");
const edgesFile = resolve(dataDir, "edges.jsonl");
const sourcesFile = resolve(dataDir, "sources.jsonl");

const cladeRecords = loadJsonl(cladeFile);
const speciesRecords = loadJsonl(speciesFile);
const edgeRecords = loadJsonl(edgesFile);
const sourceRecords = loadJsonl(sourcesFile);

const cladeIds = new Set<string>();
const speciesIds = new Set<string>();
const sourceIds = new Set<string>();

for (const { record, line } of cladeRecords) {
  if (!validateClade(record)) {
    for (const err of validateClade.errors ?? []) {
      error(cladeFile, line, `schema: ${err.instancePath} ${err.message}`);
    }
  } else {
    const clade = record as { id: string };
    cladeIds.add(clade.id);
  }
}

for (const { record, line } of sourceRecords) {
  if (!validateSource(record)) {
    for (const err of validateSource.errors ?? []) {
      error(sourcesFile, line, `schema: ${err.instancePath} ${err.message}`);
    }
  } else {
    const source = record as { id: string };
    sourceIds.add(source.id);
  }
}

for (const { record, line } of cladeRecords) {
  const clade = record as { id: string; parent: string | null };
  if (clade.parent !== null && !cladeIds.has(clade.parent)) {
    error(cladeFile, line, `referential integrity: parent '${clade.parent}' not found in clades`);
  }
}

for (const { record, line } of speciesRecords) {
  if (!validateSpecies(record)) {
    for (const err of validateSpecies.errors ?? []) {
      error(speciesFile, line, `schema: ${err.instancePath} ${err.message}`);
    }
    continue;
  }

  const species = record as {
    id: string;
    clade: string;
    sources?: string[];
  };

  speciesIds.add(species.id);

  if (!cladeIds.has(species.clade)) {
    error(speciesFile, line, `referential integrity: clade '${species.clade}' not found in clades`);
  }

  if (!species.sources || species.sources.length === 0) {
    warn(speciesFile, line, `species '${species.id}' has no sources`);
  } else {
    for (const srcId of species.sources) {
      if (!sourceIds.has(srcId)) {
        error(speciesFile, line, `referential integrity: source '${srcId}' not found in sources`);
      }
    }
  }
}

for (const { record, line } of edgeRecords) {
  if (!validateEdge(record)) {
    for (const err of validateEdge.errors ?? []) {
      error(edgesFile, line, `schema: ${err.instancePath} ${err.message}`);
    }
    continue;
  }

  const edge = record as { from: string; to: string };

  if (!speciesIds.has(edge.from)) {
    error(edgesFile, line, `referential integrity: edge.from '${edge.from}' not found in species`);
  }
  if (!speciesIds.has(edge.to)) {
    error(edgesFile, line, `referential integrity: edge.to '${edge.to}' not found in species`);
  }
}

console.log(
  `\nValidation complete: ${cladeRecords.length} clades, ${speciesRecords.length} species, ${edgeRecords.length} edges, ${sourceRecords.length} sources.`
);
console.log(`${errors} error(s), ${warnings} warning(s).`);

if (errors > 0) {
  process.exit(1);
}
