// Reads data/ (old format) → writes data2/ (new format).
//
// Predicate file naming: data2/predicates/<lens>__<slug>.json
// Two underscores separate lens from slug to avoid ambiguity with single-
// underscore slugs. Namespace-qualified predicate ids use @<lens>:<slug>.
//
// Statement ids: random base36 (7 chars) prefixed "s:" seeded with "4.0.A"
// using a deterministic mulberry32 PRNG for reproducibility.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const dataDir = join(repoRoot, "data");
const data2Dir = join(repoRoot, "data2");

// ---- PRNG: mulberry32 seeded from string ----

function seedFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

const prng = mulberry32(seedFromString("4.0.A"));
const usedIds = new Set<string>();

function nextStmtId(): string {
  const CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (;;) {
    let id = "s:";
    for (let i = 0; i < 7; i++) {
      id += CHARS[Math.floor(prng() * CHARS.length)];
    }
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}

// ---- Old-format types (minimal) ----

interface OldStatementEntry {
  value: string | number | boolean | { unknown: true } | { novalue: true };
  source?: string;
  qualifiers?: Record<string, string | number | boolean>;
  rank?: "preferred" | "normal" | "deprecated";
}

interface OldEntity {
  id: string;
  labels?: Record<string, string>;
  aliases?: string[];
  description?: string;
  statements: Record<string, OldStatementEntry[]>;
}

interface OldExtension {
  extends: string;
  statements: Record<string, OldStatementEntry[]>;
}

interface OldPredicate {
  id: string;
  label: string;
  description: string;
  lens: string;
  value_type: string;
  value_pattern?: string;
  domain: string[] | null;
  range: string[] | null;
  cardinality: string;
  inverse?: string;
  transitive?: boolean;
  deprecated?: boolean;
  alias_of?: string | null;
  expect_preferred?: boolean;
}

interface OldSource {
  id: string;
  kind: string;
  title: string;
  url: string;
  revid?: number;
  fetched?: string;
  last_verified?: string;
}

interface OldManifest {
  id: string;
  label: string;
  description: string;
  register: string;
  family?: string;
  depends_on: string[];
  source_required: boolean;
  author: string;
}

// ---- New-format types ----

interface NewStatement {
  id: string;
  predicate: string;
  value: string | number | boolean | { unknown: true } | { novalue: true };
  rank?: "preferred" | "normal" | "deprecated";
  qualifiers?: Record<string, string | number | boolean>;
  lens: string;
  sources?: Array<{ id: string; snippet?: string }>;
}

interface NewEntity {
  id: string;
  labels?: Record<string, string>;
  aliases?: string[];
  description?: string;
  statements: NewStatement[];
}

// ---- Helpers ----

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  const { appendFileSync } = require("fs") as typeof import("fs");
  appendFileSync(path, line);
}

// Parse "ns:slug" or "@ns:slug" → [ns, slug]; bare slug → [undefined, slug]
function parseId(id: string): [string | undefined, string] {
  const bare = id.startsWith("@") ? id.slice(1) : id;
  const colon = bare.indexOf(":");
  if (colon !== -1) return [bare.slice(0, colon), bare.slice(colon + 1)];
  return [undefined, bare];
}

// ---- Main conversion ----

function convert(): void {
  const lensDirs = readdirSync(join(dataDir, "lenses"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Step 1: build predicateSlug → fullId map; detect cross-lens duplicates.
  const predicateMap = new Map<string, string>(); // slug → @lens:slug
  const allPredicates: Array<{ lensId: string; pred: OldPredicate }> = [];

  for (const lensId of lensDirs) {
    const predsPath = join(dataDir, "lenses", lensId, "predicates.jsonl");
    const preds = readJsonl<OldPredicate>(predsPath);
    for (const pred of preds) {
      const slug = pred.id;
      const fullId = `@${lensId}:${slug}`;
      if (predicateMap.has(slug)) {
        process.stderr.write(
          `ERROR: Duplicate predicate slug '${slug}' in lens '${lensId}' and an earlier lens.\n`
        );
        process.exit(1);
      }
      predicateMap.set(slug, fullId);
      allPredicates.push({ lensId, pred });
    }
  }

  // Helper: qualify a predicate reference (bare slug or already-qualified)
  function qualifyPred(ref: string): string {
    if (ref.startsWith("@")) return ref;
    return predicateMap.get(ref) ?? `@unknown:${ref}`;
  }

  // Helper: qualify qualifier keys (also bare predicate slugs)
  function qualifyQualifiers(
    q: Record<string, string | number | boolean> | undefined
  ): Record<string, string | number | boolean> | undefined {
    if (!q) return undefined;
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(q)) {
      out[qualifyPred(k)] = v;
    }
    return out;
  }

  // Step 2: Write predicate files to data2/predicates/
  for (const { lensId, pred } of allPredicates) {
    const newPred = {
      id: `@${lensId}:${pred.id}`,
      label: pred.label,
      description: pred.description,
      lens: lensId,
      value_type: pred.value_type,
      ...(pred.value_pattern !== undefined && { value_pattern: pred.value_pattern }),
      domain: pred.domain
        ? pred.domain.map((d) => (d.startsWith("@") ? d : `@${d}`))
        : null,
      range: pred.range
        ? pred.range.map((r) => (r.startsWith("@") ? r : `@${r}`))
        : null,
      cardinality: pred.cardinality,
      ...(pred.inverse !== undefined && { inverse: qualifyPred(pred.inverse) }),
      ...(pred.transitive !== undefined && { transitive: pred.transitive }),
      ...(pred.deprecated !== undefined && { deprecated: pred.deprecated }),
      ...(pred.alias_of !== undefined &&
        pred.alias_of !== null && { alias_of: qualifyPred(pred.alias_of) }),
      ...(pred.expect_preferred !== undefined && { expect_preferred: pred.expect_preferred }),
    };
    const filename = `${lensId}__${pred.id}.json`;
    writeJson(join(data2Dir, "predicates", filename), newPred);
  }

  // Step 3: Write lens manifests.
  for (const lensId of lensDirs) {
    const manifestPath = join(dataDir, "lenses", lensId, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as OldManifest;
    writeJson(join(data2Dir, "lenses", `${lensId}.json`), manifest);
  }

  // Step 4: Write sources, grouped by kind.
  // Track which source ids have been written per kind to avoid duplicates.
  const writtenSourceIds = new Set<string>();

  for (const lensId of lensDirs) {
    const sourcesPath = join(dataDir, "lenses", lensId, "sources.jsonl");
    const sources = readJsonl<OldSource>(sourcesPath);
    for (const src of sources) {
      if (writtenSourceIds.has(src.id)) continue;
      writtenSourceIds.add(src.id);
      const newSrc = {
        id: src.id,
        kind: src.kind,
        title: src.title,
        url: src.url,
        ...(src.revid !== undefined && { revid: src.revid }),
        ...(src.fetched !== undefined && { fetched: src.fetched }),
        // last_verified = fetched if present, else absent
        ...(src.fetched !== undefined && { last_verified: src.last_verified ?? src.fetched }),
      };
      appendJsonl(join(data2Dir, "sources", `${src.kind}.jsonl`), newSrc);
    }
  }

  // Normalize entity id: strip leading '@'; stored key is "ns:slug", entity.id is "@ns:slug".
  function normalizeEntityKey(id: string): string {
    return id.startsWith("@") ? id.slice(1) : id;
  }
  function canonicalEntityId(id: string): string {
    return id.startsWith("@") ? id : `@${id}`;
  }

  // Step 5: Build merged entity map.
  // Map from normalized entity id (no @) → NewEntity (accumulated across lenses).
  const entityMap = new Map<string, NewEntity>();

  for (const lensId of lensDirs) {
    const entitiesPath = join(dataDir, "lenses", lensId, "entities.jsonl");
    const rawRecords = readJsonl<Record<string, unknown>>(entitiesPath);

    for (const raw of rawRecords) {
      if ("extends" in raw) {
        // Extension record: merge into existing entity.
        const ext = raw as unknown as OldExtension;
        const targetKey = normalizeEntityKey(ext.extends);
        let entity = entityMap.get(targetKey);
        if (!entity) {
          // Extension target not yet seen — create a stub to be filled later.
          entity = { id: canonicalEntityId(ext.extends), statements: [] };
          entityMap.set(targetKey, entity);
        }
        for (const [predSlug, entries] of Object.entries(ext.statements)) {
          const fullPredId = qualifyPred(predSlug);
          for (const entry of entries) {
            const stmt: NewStatement = {
              id: nextStmtId(),
              predicate: fullPredId,
              value:
                typeof entry.value === "string" ||
                typeof entry.value === "number" ||
                typeof entry.value === "boolean"
                  ? entry.value
                  : entry.value,
              lens: lensId, // extension's own lens
              ...(entry.rank !== undefined && { rank: entry.rank }),
              ...(entry.qualifiers !== undefined && {
                qualifiers: qualifyQualifiers(entry.qualifiers),
              }),
              ...(entry.source !== undefined && {
                sources: [{ id: entry.source }],
              }),
            };
            entity.statements.push(stmt);
          }
        }
      } else {
        // Definition record.
        const def = raw as unknown as OldEntity;
        const defKey = normalizeEntityKey(def.id);
        let entity = entityMap.get(defKey);
        if (!entity) {
          entity = {
            id: canonicalEntityId(def.id),
            ...(def.labels && { labels: def.labels }),
            ...(def.aliases && { aliases: def.aliases }),
            ...(def.description && { description: def.description }),
            statements: [],
          };
          entityMap.set(defKey, entity);
        } else {
          // Stub was created by an earlier extension — fill in identity fields.
          entity.id = canonicalEntityId(def.id); // upgrade stub id to canonical
          if (def.labels) entity.labels = def.labels;
          if (def.aliases) entity.aliases = def.aliases;
          if (def.description) entity.description = def.description;
        }
        for (const [predSlug, entries] of Object.entries(def.statements)) {
          const fullPredId = qualifyPred(predSlug);
          for (const entry of entries) {
            const stmt: NewStatement = {
              id: nextStmtId(),
              predicate: fullPredId,
              value: entry.value,
              lens: lensId,
              ...(entry.rank !== undefined && { rank: entry.rank }),
              ...(entry.qualifiers !== undefined && {
                qualifiers: qualifyQualifiers(entry.qualifiers),
              }),
              ...(entry.source !== undefined && {
                sources: [{ id: entry.source }],
              }),
            };
            entity.statements.push(stmt);
          }
        }
      }
    }
  }

  // Step 6: Write entity files to data2/entities/<ns>/<slug>.json
  for (const entity of entityMap.values()) {
    const [ns, slug] = parseId(entity.id);
    if (!ns) {
      process.stderr.write(`WARN: Entity '${entity.id}' has no namespace; skipping.\n`);
      continue;
    }
    writeJson(join(data2Dir, "entities", ns, `${slug}.json`), entity);
  }

  // Summary.
  const entityCount = entityMap.size;
  const predCount = allPredicates.length;
  console.log(`Converted ${entityCount} entities, ${predCount} predicates.`);
  console.log(`data2/ written to ${data2Dir}`);
}

convert();
