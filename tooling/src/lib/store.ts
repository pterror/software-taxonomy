// EAV triplestore wrapping @thi.ng/rstream-query (TripleStore).
//
// Rationale: the npm `datascript` package is a compiled ClojureScript bundle
// whose q() function requires CLJS keyword objects — plain JS strings cause
// internal comparator errors. @thi.ng/rstream-query is a native-TS in-process
// triple store with a declarative Datalog-style query spec and synchronous
// deref() on all query subscriptions.
//
// Public API: emptyDb(), transact(), q(), datumCount().

import { TripleStore } from "@thi.ng/rstream-query";
import type { QuerySpec, Solutions } from "@thi.ng/rstream-query";
import { SCHEMA, type AttributeSpec } from "./schema.js";

// Opaque handle returned by emptyDb() and consumed by the rest of the API.
export interface Db {
  _store: TripleStore;
  // Schema snapshot — used to key unique-identity attributes for entity lookup.
  _schema: Record<string, AttributeSpec>;
  // Unique-identity index: attribute → (value → subject string).
  _uniqueIndex: Map<string, Map<unknown, string>>;
  // Running entity counter for anonymous subjects.
  _nextEid: number;
}

// A fact-map passed to transact(). Keys are attribute names; no :db/id needed.
export type TxMap = Record<string, unknown>;

// Returns a fresh empty Db wrapping a TripleStore.
export function emptyDb(schema: Record<string, AttributeSpec> = SCHEMA): Db {
  return {
    _store: new TripleStore(),
    _schema: schema,
    _uniqueIndex: new Map(),
    _nextEid: 1,
  };
}

// Transacts an array of fact-maps into the db (mutates in place; returns db).
// Each fact-map is decomposed into [subject, attribute, value] triples.
// Unique-identity attributes (per schema) are used to merge maps that refer to
// the same logical entity (e.g. two maps with the same "entity/id" value).
export function transact(db: Db, txData: TxMap[]): Db {
  for (const map of txData) {
    // Determine the subject for this fact-map.
    // If any unique-identity attribute is present, reuse its canonical subject.
    let subject: string | null = null;

    for (const [attr, val] of Object.entries(map)) {
      const spec = db._schema[attr];
      if (spec?.unique && val !== undefined && val !== null) {
        let uniqueMap = db._uniqueIndex.get(attr);
        if (!uniqueMap) {
          uniqueMap = new Map();
          db._uniqueIndex.set(attr, uniqueMap);
        }
        const existing = uniqueMap.get(val);
        if (existing !== undefined) {
          subject = existing;
        } else {
          if (!subject) subject = `_e${db._nextEid++}`;
          uniqueMap.set(val, subject);
        }
        break; // first unique attr wins
      }
    }

    if (!subject) subject = `_e${db._nextEid++}`;

    // Assert each [subject, attribute, value] triple.
    for (const [attr, val] of Object.entries(map)) {
      if (val === undefined || val === null) continue;
      db._store.add([subject, attr, val]);
    }
  }
  return db;
}

// Run a @thi.ng/rstream-query QuerySpec against the store.
// Returns the raw Solutions set (Set<IObjectOf<unknown>>).
// Query variables are prefixed with "?" e.g. "?e", "?v".
//
// Example — find all entity IDs:
//   q({ q: [{ where: [["?e", "entity/id", "?v"]] }], select: ["v"] }, db)
//   → Set<{ v: string }>
export function q(spec: QuerySpec, db: Db): Solutions {
  const sub = db._store.addQueryFromSpec(spec);
  return sub.deref() ?? new Set();
}

// Return total triple count in the store.
export function datumCount(db: Db): number {
  return db._store.allIDs.size;
}
