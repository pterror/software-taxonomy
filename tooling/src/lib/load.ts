import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const dataDir = resolve(__dirname, "../../../data");
export const schemaDir = resolve(__dirname, "../../../schema");
export const lensesDir = resolve(dataDir, "lenses");

export interface LoadedRecord<T = unknown> {
  record: T;
  line: number;
  file: string;
}

export function loadJsonl<T = unknown>(filePath: string): LoadedRecord<T>[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read ${filePath}: ${msg}`);
  }

  const results: LoadedRecord<T>[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") continue;

    let record: T;
    try {
      record = JSON.parse(raw) as T;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${filePath}:${i + 1}: JSON parse error: ${msg}`);
    }

    results.push({ record, line: i + 1, file: filePath });
  }

  return results;
}

// ---- Data types ----

export type SentinelUnknown = { unknown: true };
export type SentinelNovalue = { novalue: true };
export type SentinelValue = SentinelUnknown | SentinelNovalue;

export function isSentinel(value: unknown): value is SentinelValue {
  if (typeof value !== "object" || value === null) return false;
  return ("unknown" in value && (value as Record<string, unknown>)["unknown"] === true) ||
         ("novalue" in value && (value as Record<string, unknown>)["novalue"] === true);
}

export interface StatementEntry {
  value: string | number | boolean | SentinelValue;
  source?: string;
  qualifiers?: Record<string, string | number | boolean>;
  rank?: "preferred" | "normal" | "deprecated";
}

export interface Entity {
  id: string;
  labels: Record<string, string>;
  aliases?: string[];
  description?: string;
  statements: Record<string, StatementEntry[]>;
}

export interface Predicate {
  id: string;
  label: string;
  description: string;
  lens: string;
  value_type: "string" | "integer" | "boolean" | "date" | "url" | "entity" | "language_string";
  value_pattern?: string;
  domain: string[] | null;
  range: string[] | null;
  cardinality: string;
  inverse?: string;
  transitive?: boolean;
  deprecated?: boolean;
  alias_of?: string | null;
  since_version?: string;
}

export interface Source {
  id: string;
  kind: string;
  title: string;
  url: string;
  revid?: number;
  fetched?: string;
}

export interface LensManifest {
  id: string;
  label: string;
  description: string;
  register: "factual" | "interpretive" | "fictional" | "folkloric";
  family?: string;
  depends_on: string[];
  source_required: boolean;
  author: string;
}

// ---- Lens-aware loading ----

export interface LoadedLens {
  manifest: LensManifest;
  manifestPath: string;
  predicates: LoadedRecord<Predicate>[];
  entities: LoadedRecord<Entity>[];
  sources: LoadedRecord<Source>[];
}

export interface LoadedLensSet {
  lenses: Map<string, LoadedLens>;
  /** Dependency-ordered list of lens ids (dependencies first) */
  order: string[];
}

function topoSort(lenses: Map<string, LensManifest>): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(id: string, path: string[]): void {
    if (visited.has(id)) return;
    if (path.includes(id)) {
      throw new Error(`Circular dependency in lenses: ${[...path, id].join(" -> ")}`);
    }
    const manifest = lenses.get(id);
    if (!manifest) {
      // dep missing — will be caught by manifest validation
      visited.add(id);
      return;
    }
    const newPath = [...path, id];
    for (const dep of manifest.depends_on) {
      visit(dep, newPath);
    }
    visited.add(id);
    result.push(id);
  }

  for (const id of lenses.keys()) {
    visit(id, []);
  }

  return result;
}

export function loadLensSet(filter?: string[]): LoadedLensSet {
  // Discover lens dirs
  const lensDirs = readdirSync(lensesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const manifests = new Map<string, LensManifest>();
  const manifestPaths = new Map<string, string>();

  for (const name of lensDirs) {
    const manifestPath = join(lensesDir, name, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Lens directory '${name}' is missing manifest.json`);
    }
    let manifest: LensManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as LensManifest;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot parse ${manifestPath}: ${msg}`);
    }
    if (manifest.id !== name) {
      throw new Error(`Lens dir '${name}' has manifest.id '${manifest.id}' — they must match`);
    }
    manifests.set(name, manifest);
    manifestPaths.set(name, manifestPath);
  }

  const order = topoSort(manifests);

  // If filter specified, expand to include all deps (transitively)
  let loadSet: string[];
  if (filter && filter.length > 0) {
    const needed = new Set<string>();
    function addWithDeps(id: string): void {
      if (needed.has(id)) return;
      needed.add(id);
      const m = manifests.get(id);
      if (m) {
        for (const dep of m.depends_on) addWithDeps(dep);
      }
    }
    for (const id of filter) addWithDeps(id);
    loadSet = order.filter((id) => needed.has(id));
  } else {
    loadSet = order;
  }

  const lenses = new Map<string, LoadedLens>();

  for (const id of loadSet) {
    const manifest = manifests.get(id)!;
    const lensDir = join(lensesDir, id);

    const predicatesPath = join(lensDir, "predicates.jsonl");
    const entitiesPath = join(lensDir, "entities.jsonl");
    const sourcesPath = join(lensDir, "sources.jsonl");

    lenses.set(id, {
      manifest,
      manifestPath: manifestPaths.get(id)!,
      predicates: existsSync(predicatesPath) ? loadJsonl<Predicate>(predicatesPath) : [],
      entities: existsSync(entitiesPath) ? loadJsonl<Entity>(entitiesPath) : [],
      sources: existsSync(sourcesPath) ? loadJsonl<Source>(sourcesPath) : [],
    });
  }

  return { lenses, order: loadSet };
}

// ---- Legacy single-file loaders (kept for check-links compatibility) ----

/** Returns all entities across all lenses. */
export function loadEntities(filter?: string[]): LoadedRecord<Entity>[] {
  const set = loadLensSet(filter);
  const all: LoadedRecord<Entity>[] = [];
  for (const id of set.order) {
    all.push(...set.lenses.get(id)!.entities);
  }
  return all;
}

export function loadPredicates(filter?: string[]): LoadedRecord<Predicate>[] {
  const set = loadLensSet(filter);
  const all: LoadedRecord<Predicate>[] = [];
  for (const id of set.order) {
    all.push(...set.lenses.get(id)!.predicates);
  }
  return all;
}

export function loadSources(filter?: string[]): LoadedRecord<Source>[] {
  const set = loadLensSet(filter);
  const all: LoadedRecord<Source>[] = [];
  for (const id of set.order) {
    all.push(...set.lenses.get(id)!.sources);
  }
  return all;
}
