// Helpers for locating and mutating entity JSON files in data/.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, "../../..");
export const dataDir = join(repoRoot, "data");

export interface Statement {
  id: string;
  predicate: string;
  value: unknown;
  rank?: string;
  qualifiers?: Record<string, unknown>;
  lens: string;
  sources?: Array<{ id: string; snippet?: string }>;
}

export interface EntityFile {
  id: string;
  lens?: string;
  labels?: Record<string, string>;
  aliases?: string[];
  description?: string;
  statements: Statement[];
}

// "@ns:slug" → data/entities/<ns>/<slug>.json
export function entityFilePath(entityId: string): string {
  const bare   = entityId.startsWith("@") ? entityId.slice(1) : entityId;
  const colon  = bare.indexOf(":");
  const ns     = colon >= 0 ? bare.slice(0, colon) : "unknown";
  const slug   = colon >= 0 ? bare.slice(colon + 1) : bare;
  return join(dataDir, "entities", ns, `${slug}.json`);
}

export function readEntityFile(entityId: string): EntityFile | undefined {
  const path = entityFilePath(entityId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as EntityFile;
}

export function writeEntityFile(entityId: string, content: EntityFile): void {
  const path = entityFilePath(entityId);
  writeFileSync(path, JSON.stringify(content, null, 2) + "\n", "utf-8");
}

// Collect all existing statement ids from the data/ corpus.
export function collectExistingStmtIds(): Set<string> {
  const { readdirSync } = require("fs") as typeof import("fs");
  const ids = new Set<string>();
  const entitiesBase = join(dataDir, "entities");
  if (!existsSync(entitiesBase)) return ids;
  for (const ns of readdirSync(entitiesBase)) {
    const nsDir = join(entitiesBase, ns);
    for (const file of readdirSync(nsDir)) {
      if (!file.endsWith(".json")) continue;
      const entity = JSON.parse(readFileSync(join(nsDir, file), "utf-8")) as EntityFile;
      for (const stmt of entity.statements ?? []) ids.add(stmt.id);
    }
  }
  return ids;
}

// Generate a fresh 7-char base36 statement id (collision-checked).
export function freshStmtId(existing: Set<string>): string {
  const CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (;;) {
    let id = "s:";
    for (let i = 0; i < 7; i++) {
      id += CHARS[Math.floor(Math.random() * CHARS.length)];
    }
    if (!existing.has(id)) { existing.add(id); return id; }
  }
}
