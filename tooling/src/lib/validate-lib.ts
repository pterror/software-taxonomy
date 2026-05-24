/**
 * Structural (non-graph) validation logic.
 *
 * Handles checks that require TypeScript semantics (value-type, structural consistency).
 * Graph-invariant checks (cardinality, domain/range, references, alias cycles, etc.)
 * are handled by validate.ascent via ascent-interpreter.
 */

import { LoadedLensSet, Predicate, isSentinel } from "./load.ts";
import { isInstanceOf, clearTransitiveCache, buildGraph, Graph } from "./graph.ts";

export type Severity = "error" | "warning" | "info";

export interface Violation {
  severity: Severity;
  lens: string;
  file: string;
  line: number;
  entityId: string;
  predicateId: string;
  rule: string;
  message: string;
}

export interface LensSummary {
  lensId: string;
  entities: number;
  predicates: number;
  sources: number;
  errors: number;
  warnings: number;
}

export interface ValidationResult {
  violations: Violation[];
  summaries: LensSummary[];
  totalErrors: number;
  totalWarnings: number;
}

// ---- Value type checks ----

const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const URL_RE = /^https?:\/\/.+/;
const INT_RE = /^-?\d+$/;

function checkValueType(
  value: string | number | boolean,
  predicate: Predicate
): string | null {
  switch (predicate.value_type) {
    case "string":
    case "language_string":
      if (typeof value !== "string") return `expected string, got ${typeof value}`;
      if (predicate.value_pattern) {
        const re = new RegExp(predicate.value_pattern);
        if (!re.test(value as string)) {
          return `value '${value}' does not match pattern '${predicate.value_pattern}'`;
        }
      }
      return null;
    case "integer":
      if (typeof value === "number" && Number.isInteger(value)) return null;
      if (typeof value === "string" && INT_RE.test(value)) return null;
      return `expected integer, got '${value}'`;
    case "boolean":
      if (typeof value !== "boolean") return `expected boolean, got ${typeof value}`;
      return null;
    case "date":
      if (typeof value !== "string") return `expected date string, got ${typeof value}`;
      if (!DATE_RE.test(value)) return `'${value}' is not a valid date (expected YYYY, YYYY-MM, or YYYY-MM-DD)`;
      if (predicate.value_pattern) {
        const re = new RegExp(predicate.value_pattern);
        if (!re.test(value)) return `date '${value}' does not match pattern '${predicate.value_pattern}'`;
      }
      return null;
    case "url":
      if (typeof value !== "string") return `expected URL string, got ${typeof value}`;
      if (!URL_RE.test(value)) return `'${value}' is not a valid URL`;
      return null;
    case "entity":
      if (typeof value !== "string" || !value.startsWith("@")) {
        return `expected entity reference (starting with @), got '${value}'`;
      }
      return null;
  }
}

// ---- Main validation ----

export function validate(lensSet: LoadedLensSet, targetLens?: Set<string>): ValidationResult {
  clearTransitiveCache();
  const graph = buildGraph(undefined, lensSet);
  const violations: Violation[] = [];
  const summaries: LensSummary[] = [];

  function violation(
    severity: Severity, lens: string, file: string, line: number,
    entityId: string, predicateId: string, rule: string, message: string
  ) {
    violations.push({ severity, lens, file, line, entityId, predicateId, rule, message });
  }

  // Lens dependency cycles (detected during load)
  for (const msg of lensSet.cycleViolations) {
    violation("error", "global", "(manifest)", 0, "?", "?", "lens-dependency-cycle", msg);
  }

  // Build global predicate index
  const predicateIndex = new Map<string, Predicate>();
  const predicateLens = new Map<string, string>();

  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    for (const { record: pred } of lens.predicates) {
      if (predicateIndex.has(pred.id)) {
        violation("error", "global", "(predicate index)", 0, "?", pred.id, "duplicate-predicate-id",
          `Predicate '${pred.id}' defined in both '${predicateLens.get(pred.id)}' and '${lensId}'`);
      } else {
        predicateIndex.set(pred.id, pred);
        predicateLens.set(pred.id, lensId);
      }
    }
  }

  /** Resolve predicate, following alias_of chains up to 5 hops. Returns [resolved, aliasedFrom] */
  function resolvePredicate(id: string): [Predicate | undefined, string | undefined] {
    const pred = predicateIndex.get(id);
    if (!pred) return [undefined, undefined];
    if (!pred.alias_of) return [pred, undefined];

    let current = pred;
    let hops = 0;
    const firstAlias = id;
    while (current.alias_of) {
      hops++;
      if (hops > 5) {
        violation("error", predicateLens.get(id) ?? "global", "(predicate index)", 0, "?", id,
          "alias-chain-too-long", `predicate '${id}' alias_of chain exceeds 5 hops`);
        return [undefined, firstAlias];
      }
      const next = predicateIndex.get(current.alias_of);
      if (!next) return [undefined, firstAlias];
      if (next.id === id) {
        // cycle detected — alias_cycle is handled by Datalog; skip here
        return [undefined, firstAlias];
      }
      current = next;
    }
    return [current, firstAlias];
  }

  // Build entity owner map
  const entityOwner = new Map<string, string>();
  for (const lensId of lensSet.order) {
    for (const { record: entity } of lensSet.lenses.get(lensId)!.entities) {
      if (!entityOwner.has(entity.id)) entityOwner.set(entity.id, lensId);
    }
  }

  // Per-lens structural + value-type validation
  for (const lensId of lensSet.order) {
    const isTargeted = !targetLens || targetLens.has(lensId);
    const lens = lensSet.lenses.get(lensId)!;

    let lensErrors = 0;
    let lensWarnings = 0;
    const countBefore = violations.length;

    if (isTargeted) {
      // Predicate lens-mismatch
      for (const { record: pred, file, line } of lens.predicates) {
        if (pred.lens !== lensId) {
          violation("error", lensId, file, line, pred.id, pred.id, "predicate-lens-mismatch",
            `predicate.lens is '${pred.lens}' but file is in lens '${lensId}'`);
        }
      }

      // Extension structural checks
      for (const { record: ext, file, line } of lens.extensions) {
        const targetId = ext.extends.startsWith("@") ? ext.extends.slice(1) : ext.extends;

        if (!graph.entities.has(targetId)) {
          violation("error", lensId, file, line, targetId, "?", "dangling-extension",
            `extension record targets '${ext.extends}' which does not exist in any loaded lens`);
          continue;
        }

        if (entityOwner.get(targetId) === lensId) {
          violation("error", lensId, file, line, targetId, "?", "own-entity-extension",
            `lens '${lensId}' owns entity '${targetId}' — use the definition record instead of an extension`);
          continue;
        }

        for (const [predId, entries] of Object.entries(ext.statements)) {
          const [pred, aliasedFrom] = resolvePredicate(predId);
          if (!pred) {
            violation("warning", lensId, file, line, targetId, predId, "unknown-predicate",
              `predicate '${predId}' in extension record is not defined in any loaded lens`);
            continue;
          }
          if (aliasedFrom) {
            // Alias constraints now cascade via Datalog (effective_predicate_def); no INFO needed.
            void aliasedFrom;
          }
          for (const entry of entries) {
            if (entry.rank === "deprecated" || isSentinel(entry.value)) continue;
            const typeErr = checkValueType(entry.value as string | number | boolean, pred);
            if (typeErr) violation("error", lensId, file, line, targetId, predId, "value-type", typeErr);
            if (entry.qualifiers) validateQualifierTypes(entry.qualifiers, predId, targetId, lensId, file, line, violations, predicateIndex);
          }
        }
      }

      // Entity validation
      for (const { record: entity, file, line } of lens.entities) {
        for (const [predId, entries] of Object.entries(entity.statements)) {
          const [pred, aliasedFrom] = resolvePredicate(predId);
          if (!pred) {
            violation("warning", lensId, file, line, entity.id, predId, "unknown-predicate",
              `predicate '${predId}' is not defined in any loaded lens`);
            continue;
          }
          if (aliasedFrom) {
            violation("info", lensId, file, line, entity.id, predId, "alias-usage",
              `predicate '${predId}' is an alias of '${pred.id}'; using canonical constraints`);
          }
          if (pred.deprecated) {
            for (const entry of entries) {
              if (entry.rank !== "deprecated") {
                violation("warning", lensId, file, line, entity.id, predId, "deprecated-predicate",
                  `predicate '${predId}' is deprecated — see predicate description for successor`);
              }
            }
          }
          for (const entry of entries) {
            if (entry.rank === "deprecated" || isSentinel(entry.value)) continue;
            const typeErr = checkValueType(entry.value as string | number | boolean, pred);
            if (typeErr) violation("error", lensId, file, line, entity.id, predId, "value-type", typeErr);
            if (entry.qualifiers) validateQualifierTypes(entry.qualifiers, predId, entity.id, lensId, file, line, violations, predicateIndex);
          }
        }
      }
    }

    for (let i = countBefore; i < violations.length; i++) {
      if (violations[i].severity === "error") lensErrors++;
      else if (violations[i].severity === "warning") lensWarnings++;
    }

    summaries.push({
      lensId,
      entities: lens.entities.length + lens.extensions.length,
      predicates: lens.predicates.length,
      sources: lens.sources.length,
      errors: lensErrors,
      warnings: lensWarnings,
    });
  }

  const totalErrors = violations.filter(v => v.severity === "error").length;
  const totalWarnings = violations.filter(v => v.severity === "warning").length;
  return { violations, summaries, totalErrors, totalWarnings };
}

function validateQualifierTypes(
  qualifiers: Record<string, unknown>,
  predId: string,
  entityId: string,
  lensId: string,
  file: string,
  line: number,
  violations: Violation[],
  predicateIndex: Map<string, Predicate>
): void {
  for (const [qPredId, qVal] of Object.entries(qualifiers)) {
    if (isSentinel(qVal)) continue;
    const qPredDef = predicateIndex.get(qPredId);
    if (!qPredDef) continue; // unknown predicate — handled by Datalog

    const typeErr = checkValueType(qVal as string | number | boolean, qPredDef);
    if (typeErr) {
      violations.push({ severity: "error", lens: lensId, file, line, entityId, predicateId: predId,
        rule: "qualifier-value-type", message: `qualifier '${qPredId}': ${typeErr}` });
    }
    if (qPredDef.value_type === "entity" && typeof qVal === "string" && !qVal.startsWith("@")) {
      violations.push({ severity: "error", lens: lensId, file, line, entityId, predicateId: predId,
        rule: "qualifier-value-type",
        message: `qualifier '${qPredId}': expected entity reference (starting with @), got '${qVal}'` });
    }
  }
}
