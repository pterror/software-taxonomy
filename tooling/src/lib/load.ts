import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const dataDir = resolve(__dirname, "../../../data");
export const schemaDir = resolve(__dirname, "../../../schema");

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

export interface StatementEntry {
  value: string | number | boolean;
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
  domain_hint?: string[];
  range_hint?: string[];
  inverse?: string;
  transitive?: boolean;
}

export interface Source {
  id: string;
  kind: string;
  title: string;
  url: string;
  revid?: number;
  fetched?: string;
}

export function loadEntities(): LoadedRecord<Entity>[] {
  return loadJsonl<Entity>(resolve(dataDir, "entities.jsonl"));
}

export function loadPredicates(): LoadedRecord<Predicate>[] {
  return loadJsonl<Predicate>(resolve(dataDir, "predicates.jsonl"));
}

export function loadSources(): LoadedRecord<Source>[] {
  return loadJsonl<Source>(resolve(dataDir, "sources.jsonl"));
}
