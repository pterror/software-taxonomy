// Reads data2/ → transacts everything into a fresh EAV store. Returns the db.
// Also tracks :statement/file and :statement/line by scanning JSON text for
// each statement id (ids are globally unique after convert.ts assigns them).

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { emptyDb, transact, datumCount, type TxMap, type Db } from "./store.js";
import { SCHEMA } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");
const data2Dir = join(repoRoot, "data2");

// ---- New-format types (mirroring convert.ts output) ----

interface NewStatement {
  id: string;
  predicate: string;
  value: unknown;
  rank?: string;
  qualifiers?: Record<string, unknown>;
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

interface NewPredicate {
  id: string;
  label: string;
  description: string;
  lens: string;
  value_type: string;
  domain: string[] | null;
  range: string[] | null;
  cardinality: string;
  inverse?: string;
  transitive?: boolean;
  deprecated?: boolean;
  alias_of?: string | null;
  expect_preferred?: boolean;
}

interface NewSource {
  id: string;
  kind: string;
  title: string;
  url: string;
  revid?: number;
  fetched?: string;
  last_verified?: string;
}

interface NewLens {
  id: string;
  label: string;
  description: string;
  register: string;
  family?: string;
  depends_on: string[];
  source_required: boolean;
  author: string;
}

// Find the 1-based line number of a statement id in file text.
// Searches for the first occurrence of '"id": "<stmtId>"' or '"id":"<stmtId>"'.
function findStatementLine(text: string, stmtId: string): number {
  // Match the opening brace preceding the "id" key of this statement.
  // We search for the id value and then walk back to find the '{'.
  const needle = `"${stmtId}"`;
  const pos = text.indexOf(needle);
  if (pos === -1) return -1;
  // Count newlines up to pos to get line number (1-based).
  let line = 1;
  for (let i = 0; i < pos; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

// Load data2/ and return a populated db.
export function loadData2(baseDir: string = data2Dir): Db {
  const db = emptyDb(SCHEMA);

  // --- Lenses ---
  const lensesDir = join(baseDir, "lenses");
  if (existsSync(lensesDir)) {
    for (const file of readdirSync(lensesDir)) {
      if (!file.endsWith(".json")) continue;
      const lens = JSON.parse(readFileSync(join(lensesDir, file), "utf-8")) as NewLens;
      transact(db, [{
        "lens/id":             lens.id,
        "lens/label":          lens.label,
        "lens/description":    lens.description,
        "lens/register":       lens.register,
        ...(lens.family   !== undefined && { "lens/family":      lens.family }),
        "lens/depends_on":     JSON.stringify(lens.depends_on),
        "lens/source_required": lens.source_required,
        "lens/author":         lens.author,
      } as TxMap]);
    }
  }

  // --- Predicates ---
  const predsDir = join(baseDir, "predicates");
  if (existsSync(predsDir)) {
    for (const file of readdirSync(predsDir)) {
      if (!file.endsWith(".json")) continue;
      const pred = JSON.parse(readFileSync(join(predsDir, file), "utf-8")) as NewPredicate;
      transact(db, [{
        "predicate/id":          pred.id,
        "predicate/lens":        pred.lens,
        "predicate/label":       pred.label,
        "predicate/description": pred.description,
        "predicate/value_type":  pred.value_type,
        "predicate/domain":      JSON.stringify(pred.domain),
        "predicate/range":       JSON.stringify(pred.range),
        "predicate/cardinality": pred.cardinality,
        ...(pred.inverse          !== undefined && { "predicate/inverse":          pred.inverse }),
        ...(pred.transitive       !== undefined && { "predicate/transitive":       pred.transitive }),
        ...(pred.deprecated       !== undefined && { "predicate/deprecated":       pred.deprecated }),
        ...(pred.alias_of         !== undefined && pred.alias_of !== null && { "predicate/alias_of": pred.alias_of }),
        ...(pred.expect_preferred !== undefined && { "predicate/expect_preferred": pred.expect_preferred }),
      } as TxMap]);
    }
  }

  // --- Sources ---
  const sourcesDir = join(baseDir, "sources");
  if (existsSync(sourcesDir)) {
    for (const file of readdirSync(sourcesDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const lines = readFileSync(join(sourcesDir, file), "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      for (const line of lines) {
        const src = JSON.parse(line) as NewSource;
        transact(db, [{
          "source/id":    src.id,
          "source/kind":  src.kind,
          "source/title": src.title,
          "source/url":   src.url,
          ...(src.revid         !== undefined && { "source/revid":         src.revid }),
          ...(src.fetched       !== undefined && { "source/fetched":       src.fetched }),
          ...(src.last_verified !== undefined && { "source/last_verified": src.last_verified }),
        } as TxMap]);
      }
    }
  }

  // --- Entities and Statements ---
  const entitiesBase = join(baseDir, "entities");
  if (existsSync(entitiesBase)) {
    for (const ns of readdirSync(entitiesBase)) {
      const nsDir = join(entitiesBase, ns);
      for (const file of readdirSync(nsDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(nsDir, file);
        const fileText = readFileSync(filePath, "utf-8");
        const entity = JSON.parse(fileText) as NewEntity;

        // Transact entity record.
        transact(db, [{
          "entity/id":          entity.id,
          ...(entity.labels      !== undefined && { "entity/labels":      JSON.stringify(entity.labels) }),
          ...(entity.aliases     !== undefined && { "entity/aliases":     JSON.stringify(entity.aliases) }),
          ...(entity.description !== undefined && { "entity/description": entity.description }),
        } as TxMap]);

        // Transact each statement.
        for (const stmt of entity.statements) {
          const line = findStatementLine(fileText, stmt.id);
          transact(db, [{
            "statement/id":        stmt.id,
            "statement/subject":   entity.id,
            "statement/predicate": stmt.predicate,
            "statement/value":     String(stmt.value),
            "statement/lens":      stmt.lens,
            "statement/file":      filePath,
            ...(line !== -1 && { "statement/line": line }),
            ...(stmt.rank       !== undefined && { "statement/rank":       stmt.rank }),
            ...(stmt.qualifiers !== undefined && { "statement/qualifiers": JSON.stringify(stmt.qualifiers) }),
          } as TxMap]);

          // Transact src-links for each source reference.
          if (stmt.sources) {
            for (const srcRef of stmt.sources) {
              transact(db, [{
                "src-link/statement": stmt.id,
                "src-link/source":    srcRef.id,
                ...(srcRef.snippet !== undefined && { "src-link/snippet": srcRef.snippet }),
              } as TxMap]);
            }
          }
        }
      }
    }
  }

  return db;
}

// Smoke-test entry point: load and print datom count.
if (import.meta.main) {
  const db = loadData2();
  console.log(`Loaded data2/. Total datoms: ${datumCount(db)}`);
}
