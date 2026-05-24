// Attribute schema for the EAV triplestore in store.ts.
// Cardinality "many" attributes store arrays; "one" attributes store scalars.
// Unique-identity attributes enforce one value per entity id.

export type Cardinality = "one" | "many";
export type ValueType = "string" | "number" | "boolean" | "json";

export interface AttributeSpec {
  cardinality: Cardinality;
  valueType: ValueType;
  unique?: boolean; // unique identity — enforce one datom per logical entity key
}

// Attribute registry used by emptyDb() in store.ts.
export const SCHEMA: Record<string, AttributeSpec> = {
  // --- Entity ---
  "entity/id":          { cardinality: "one", valueType: "string", unique: true },
  "entity/lens":        { cardinality: "one", valueType: "string" }, // owner lens id
  "entity/labels":      { cardinality: "one", valueType: "json" },   // JSON-stringified Record<string,string>
  "entity/aliases":     { cardinality: "one", valueType: "json" },   // JSON-stringified string[]
  "entity/description": { cardinality: "one", valueType: "string" },

  // --- Statement ---
  "statement/id":         { cardinality: "one", valueType: "string", unique: true },
  "statement/subject":    { cardinality: "one", valueType: "string" }, // entity id ref
  "statement/predicate":  { cardinality: "one", valueType: "string" }, // full predicate id
  "statement/value":      { cardinality: "one", valueType: "string" },
  "statement/rank":       { cardinality: "one", valueType: "string" },
  "statement/lens":       { cardinality: "one", valueType: "string" },
  "statement/file":       { cardinality: "one", valueType: "string" },
  "statement/line":       { cardinality: "one", valueType: "number" },
  "statement/qualifiers": { cardinality: "one", valueType: "json" },  // JSON-stringified qualifier map

  // --- Predicate ---
  "predicate/id":              { cardinality: "one", valueType: "string", unique: true },
  "predicate/lens":            { cardinality: "one", valueType: "string" },
  "predicate/label":           { cardinality: "one", valueType: "string" },
  "predicate/value_type":      { cardinality: "one", valueType: "string" },
  "predicate/domain":          { cardinality: "one", valueType: "json" },  // JSON-stringified string[]|null
  "predicate/range":           { cardinality: "one", valueType: "json" },
  "predicate/cardinality":     { cardinality: "one", valueType: "string" },
  "predicate/expect_preferred":{ cardinality: "one", valueType: "boolean" },
  "predicate/transitive":      { cardinality: "one", valueType: "boolean" },
  "predicate/inverse":         { cardinality: "one", valueType: "string" },
  "predicate/alias_of":        { cardinality: "one", valueType: "string" },
  "predicate/deprecated":      { cardinality: "one", valueType: "boolean" },
  "predicate/description":     { cardinality: "one", valueType: "string" },

  // --- Source ---
  "source/id":            { cardinality: "one", valueType: "string", unique: true },
  "source/kind":          { cardinality: "one", valueType: "string" },
  "source/title":         { cardinality: "one", valueType: "string" },
  "source/url":           { cardinality: "one", valueType: "string" },
  "source/revid":         { cardinality: "one", valueType: "number" },
  "source/fetched":       { cardinality: "one", valueType: "string" },
  "source/last_verified": { cardinality: "one", valueType: "string" },

  // --- Src-link (statement ↔ source many-to-many junction) ---
  "src-link/statement": { cardinality: "one", valueType: "string" }, // statement id
  "src-link/source":    { cardinality: "one", valueType: "string" }, // source id
  "src-link/snippet":   { cardinality: "one", valueType: "string" },

  // --- Lens ---
  "lens/id":             { cardinality: "one", valueType: "string", unique: true },
  "lens/label":          { cardinality: "one", valueType: "string" },
  "lens/register":       { cardinality: "one", valueType: "string" },
  "lens/family":         { cardinality: "one", valueType: "string" },
  "lens/depends_on":     { cardinality: "one", valueType: "json" },  // JSON-stringified string[]
  "lens/source_required":{ cardinality: "one", valueType: "boolean" },
  "lens/author":         { cardinality: "one", valueType: "string" },
  "lens/description":    { cardinality: "one", valueType: "string" },
};
