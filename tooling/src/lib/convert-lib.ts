// Shared conversion logic extracted from convert.ts for use in fixture converter.
// Converts old-format lens directories into data2-style directories.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";

// ─── PRNG (same as convert.ts) ────────────────────────────────────────────────

function seedFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OldStatementEntry {
  value: string | number | boolean | { unknown: true } | { novalue: true };
  source?: string;
  qualifiers?: Record<string, string | number | boolean>;
  rank?: "preferred" | "normal" | "deprecated";
}

export interface OldEntity {
  id: string;
  labels?: Record<string, string>;
  aliases?: string[];
  description?: string;
  statements: Record<string, OldStatementEntry[]>;
}

export interface OldExtension {
  extends: string;
  statements: Record<string, OldStatementEntry[]>;
}

export interface OldPredicate {
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

export interface OldSource {
  id: string;
  kind: string;
  title: string;
  url: string;
  revid?: number;
  fetched?: string;
  last_verified?: string;
}

export interface OldManifest {
  id: string;
  label: string;
  description: string;
  register: string;
  family?: string;
  depends_on: string[];
  source_required: boolean;
  author: string;
}

export interface NewStatement {
  id: string;
  predicate: string;
  value: OldStatementEntry["value"];
  rank?: "preferred" | "normal" | "deprecated";
  qualifiers?: Record<string, string | number | boolean>;
  lens: string;
  sources?: Array<{ id: string; snippet?: string }>;
}

export interface NewEntity {
  id: string;
  lens?: string;  // owner lens id (lens that first defined this entity)
  labels?: Record<string, string>;
  aliases?: string[];
  description?: string;
  statements: NewStatement[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  const { appendFileSync } = require("fs") as typeof import("fs");
  appendFileSync(path, line);
}

export function parseId(id: string): [string | undefined, string] {
  const bare = id.startsWith("@") ? id.slice(1) : id;
  const colon = bare.indexOf(":");
  if (colon !== -1) return [bare.slice(0, colon), bare.slice(colon + 1)];
  return [undefined, bare];
}

export function normalizeEntityKey(id: string): string {
  return id.startsWith("@") ? id.slice(1) : id;
}

export function canonicalEntityId(id: string): string {
  return id.startsWith("@") ? id : `@${id}`;
}

// ─── Main conversion logic ────────────────────────────────────────────────────

export interface ConvertOptions {
  /** Source lenses directory (old format) */
  lensesDir: string;
  /** Destination data2-style directory */
  outDir: string;
  /** PRNG seed string (default: "4.0.A" for main corpus; use fixture name for fixture) */
  seed?: string;
}

export function convertLenses(opts: ConvertOptions): void {
  const { lensesDir, outDir, seed = "4.0.A" } = opts;
  const prng = mulberry32(seedFromString(seed));
  const usedIds = new Set<string>();

  function nextStmtId(): string {
    const CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
    for (;;) {
      let id = "s:";
      for (let i = 0; i < 7; i++) id += CHARS[Math.floor(prng() * CHARS.length)];
      if (!usedIds.has(id)) { usedIds.add(id); return id; }
    }
  }

  const lensDirs = readdirSync(lensesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Step 1: Build predicate slug → qualified id map
  const predicateMap = new Map<string, string>();
  const allPredicates: Array<{ lensId: string; pred: OldPredicate }> = [];

  for (const lensId of lensDirs) {
    const preds = readJsonl<OldPredicate>(join(lensesDir, lensId, "predicates.jsonl"));
    for (const pred of preds) {
      const slug = pred.id;
      predicateMap.set(slug, `@${lensId}:${slug}`);
      allPredicates.push({ lensId, pred });
    }
  }

  function qualifyPred(ref: string): string {
    if (ref.startsWith("@")) return ref;
    return predicateMap.get(ref) ?? `@unknown:${ref}`;
  }

  function qualifyQualifiers(
    q: Record<string, string | number | boolean> | undefined
  ): Record<string, string | number | boolean> | undefined {
    if (!q) return undefined;
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(q)) out[qualifyPred(k)] = v;
    return out;
  }

  // Step 2: Write predicate files
  for (const { lensId, pred } of allPredicates) {
    const newPred = {
      id: `@${lensId}:${pred.id}`,
      label: pred.label,
      description: pred.description,
      lens: pred.lens, // preserve original lens field (may differ from lensId — that's the mismatch)
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
      ...(pred.alias_of !== undefined && pred.alias_of !== null && { alias_of: qualifyPred(pred.alias_of) }),
      ...(pred.expect_preferred !== undefined && { expect_preferred: pred.expect_preferred }),
    };
    writeJson(join(outDir, "predicates", `${lensId}__${pred.id}.json`), newPred);
  }

  // Step 3: Write lens manifests
  for (const lensId of lensDirs) {
    const manifestPath = join(lensesDir, lensId, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as OldManifest;
    writeJson(join(outDir, "lenses", `${lensId}.json`), manifest);
  }

  // Step 4: Write sources
  const writtenSourceIds = new Set<string>();
  for (const lensId of lensDirs) {
    const sources = readJsonl<OldSource>(join(lensesDir, lensId, "sources.jsonl"));
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
        ...(src.fetched !== undefined && { last_verified: src.last_verified ?? src.fetched }),
      };
      appendJsonl(join(outDir, "sources", `${src.kind}.jsonl`), newSrc);
    }
  }

  // Step 5: Build and write entities
  const entityMap = new Map<string, NewEntity>();

  for (const lensId of lensDirs) {
    const rawRecords = readJsonl<Record<string, unknown>>(join(lensesDir, lensId, "entities.jsonl"));

    for (const raw of rawRecords) {
      if ("extends" in raw) {
        const ext = raw as unknown as OldExtension;
        const targetKey = normalizeEntityKey(ext.extends);
        let entity = entityMap.get(targetKey);
        if (!entity) {
          // Stub: owner unknown until we see the definition record
          entity = { id: canonicalEntityId(ext.extends), statements: [] };
          entityMap.set(targetKey, entity);
        }
        for (const [predSlug, entries] of Object.entries(ext.statements)) {
          const fullPredId = qualifyPred(predSlug);
          for (const entry of entries) {
            entity.statements.push({
              id: nextStmtId(),
              predicate: fullPredId,
              value: entry.value,
              lens: lensId,
              ...(entry.rank !== undefined && { rank: entry.rank }),
              ...(entry.qualifiers !== undefined && { qualifiers: qualifyQualifiers(entry.qualifiers) }),
              ...(entry.source !== undefined && { sources: [{ id: entry.source }] }),
            });
          }
        }
      } else {
        const def = raw as unknown as OldEntity;
        const defKey = normalizeEntityKey(def.id);
        let entity = entityMap.get(defKey);
        if (!entity) {
          entity = {
            id: canonicalEntityId(def.id),
            lens: lensId, // first definer = owner
            ...(def.labels && { labels: def.labels }),
            ...(def.aliases && { aliases: def.aliases }),
            ...(def.description && { description: def.description }),
            statements: [],
          };
          entityMap.set(defKey, entity);
        } else {
          entity.id = canonicalEntityId(def.id);
          if (!entity.lens) entity.lens = lensId; // first definer wins
          if (def.labels) entity.labels = def.labels;
          if (def.aliases) entity.aliases = def.aliases;
          if (def.description) entity.description = def.description;
        }
        for (const [predSlug, entries] of Object.entries(def.statements)) {
          const fullPredId = qualifyPred(predSlug);
          for (const entry of entries) {
            entity.statements.push({
              id: nextStmtId(),
              predicate: fullPredId,
              value: entry.value,
              lens: lensId,
              ...(entry.rank !== undefined && { rank: entry.rank }),
              ...(entry.qualifiers !== undefined && { qualifiers: qualifyQualifiers(entry.qualifiers) }),
              ...(entry.source !== undefined && { sources: [{ id: entry.source }] }),
            });
          }
        }
      }
    }
  }

  // Step 6: Write entity files
  for (const entity of entityMap.values()) {
    const [ns, slug] = parseId(entity.id);
    if (!ns) continue;
    writeJson(join(outDir, "entities", ns, `${slug}.json`), entity);
  }
}
