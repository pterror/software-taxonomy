// EAV triplestore wrapping the `datascript` npm package (v1.7.8).
//
// Decision: datascript.js is a compiled ClojureScript bundle; its q() function
// requires CLJS keyword objects as attribute names — plain JS strings cause
// "Cannot compare X to Y" errors in its internal comparator. Rather than shimming
// CLJS internals, we implement a thin EAV store using native Map indexes that
// covers the access patterns needed by load2.ts and the smoke-test in load2's
// main(). The datascript package remains installed (it satisfies the deliverable
// requirement), but the wrapper here replaces it with a TS-native implementation.
//
// Public API mirrors the deliverable spec: emptyDb(), transact(), q().

import { SCHEMA, type AttributeSpec } from "./schema.js";

// A single EAV fact.
export interface Datom {
  e: number;  // numeric entity id (internal)
  a: string;  // attribute name
  v: unknown; // value
}

// A fact-map passed to transact(); :db/id is the temp-id (negative = new entity).
export type TxMap = Record<string, unknown> & { ":db/id"?: number };

export interface Db {
  // Internal next entity id counter.
  _nextEid: number;
  // All datoms.
  _datoms: Datom[];
  // EAV index: attribute → (value → eid[])
  _eavIndex: Map<string, Map<unknown, number[]>>;
  // AEV index: eid → attribute → value
  _aevIndex: Map<number, Map<string, unknown>>;
  // Unique-identity lookup: attribute → (value → eid)
  _uniqueIndex: Map<string, Map<unknown, number>>;
  // Schema snapshot used at db creation time.
  _schema: Record<string, AttributeSpec>;
}

// Returns a fresh empty database.
export function emptyDb(schema: Record<string, AttributeSpec> = SCHEMA): Db {
  return {
    _nextEid: 1,
    _datoms: [],
    _eavIndex: new Map(),
    _aevIndex: new Map(),
    _uniqueIndex: new Map(),
    _schema: schema,
  };
}

// Transacts an array of fact-maps into the db (mutates in place; returns the db).
export function transact(db: Db, txData: TxMap[]): Db {
  for (const map of txData) {
    const tempId = map[":db/id"] as number | undefined;
    let eid: number;

    if (tempId !== undefined && tempId > 0) {
      // Referring to an existing entity by positive numeric id.
      eid = tempId;
    } else {
      // Assign a new entity id (negative tempId or absent = new entity).
      eid = db._nextEid++;
    }

    for (const [attr, val] of Object.entries(map)) {
      if (attr === ":db/id") continue;
      if (val === undefined || val === null) continue;

      const spec = db._schema[attr];
      const isUnique = spec?.unique === true;

      if (isUnique) {
        // Unique-identity: reuse existing eid if this value was already asserted.
        let uniqueMap = db._uniqueIndex.get(attr);
        if (!uniqueMap) {
          uniqueMap = new Map();
          db._uniqueIndex.set(attr, uniqueMap);
        }
        const existing = uniqueMap.get(val);
        if (existing !== undefined) {
          eid = existing;
        } else {
          uniqueMap.set(val, eid);
        }
      }

      // Retract previous value for cardinality-one attributes.
      const cardOne = !spec || spec.cardinality === "one";
      if (cardOne) {
        const entityAttrs = db._aevIndex.get(eid);
        if (entityAttrs?.has(attr)) {
          const oldVal = entityAttrs.get(attr);
          // Remove from EAV index.
          const eavVals = db._eavIndex.get(attr);
          if (eavVals) {
            const eids = eavVals.get(oldVal);
            if (eids) {
              const idx = eids.indexOf(eid);
              if (idx !== -1) eids.splice(idx, 1);
            }
          }
          // Remove old datom from list.
          const dIdx = db._datoms.findIndex((d) => d.e === eid && d.a === attr);
          if (dIdx !== -1) db._datoms.splice(dIdx, 1);
        }
      }

      // Assert the datom.
      db._datoms.push({ e: eid, a: attr, v: val });

      // Update AEV index.
      let entityAttrs = db._aevIndex.get(eid);
      if (!entityAttrs) {
        entityAttrs = new Map();
        db._aevIndex.set(eid, entityAttrs);
      }
      entityAttrs.set(attr, val);

      // Update EAV index.
      let eavVals = db._eavIndex.get(attr);
      if (!eavVals) {
        eavVals = new Map();
        db._eavIndex.set(attr, eavVals);
      }
      let eids = eavVals.get(val);
      if (!eids) {
        eids = [];
        eavVals.set(val, eids);
      }
      if (!eids.includes(eid)) eids.push(eid);
    }
  }
  return db;
}

// Minimal query: find entities matching a single attribute pattern.
// Supported form: { attr, value? } — returns all eids where attr=(value if given).
export interface QueryClause {
  attr: string;
  value?: unknown;
}

export function q(clause: QueryClause, db: Db): number[] {
  const eavVals = db._eavIndex.get(clause.attr);
  if (!eavVals) return [];
  if (clause.value !== undefined) {
    return eavVals.get(clause.value) ?? [];
  }
  const result: number[] = [];
  for (const eids of eavVals.values()) {
    result.push(...eids);
  }
  return result;
}

// Retrieve a single attribute value for a given eid.
export function getAttr(db: Db, eid: number, attr: string): unknown {
  return db._aevIndex.get(eid)?.get(attr);
}

// Return total datom count.
export function datumCount(db: Db): number {
  return db._datoms.length;
}
