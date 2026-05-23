/**
 * Pure SHACL-lite validation logic.
 * No I/O — takes a LoadedLensSet and returns violations.
 */

import { LoadedLensSet, Entity, Predicate, LensManifest, isSentinel } from "./load.ts";
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

// ---- Cardinality helpers ----

function parseCardinality(card: string): { min: number; max: number | null } {
  const parts = card.split("..");
  if (parts.length !== 2) return { min: 0, max: null };
  const min = parseInt(parts[0], 10);
  const max = parts[1] === "*" ? null : parseInt(parts[1], 10);
  return { min, max };
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

  // Build graph from full lens set (all loaded lenses — needed for transitive checks)
  const graph = buildGraph();

  const violations: Violation[] = [];
  const summaries: LensSummary[] = [];

  function violation(
    severity: Severity,
    lens: string,
    file: string,
    line: number,
    entityId: string,
    predicateId: string,
    rule: string,
    message: string
  ) {
    violations.push({ severity, lens, file, line, entityId, predicateId, rule, message });
  }

  // Build global predicate index (check for duplicates)
  const predicateIndex = new Map<string, Predicate>();
  const predicateLens = new Map<string, string>();
  const predicateDupErrors: string[] = [];

  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    for (const { record: pred } of lens.predicates) {
      if (predicateIndex.has(pred.id)) {
        predicateDupErrors.push(
          `Predicate '${pred.id}' defined in both '${predicateLens.get(pred.id)}' and '${lensId}'`
        );
      } else {
        predicateIndex.set(pred.id, pred);
        predicateLens.set(pred.id, lensId);
      }
    }
  }

  for (const msg of predicateDupErrors) {
    violations.push({
      severity: "error",
      lens: "global",
      file: "(predicate index)",
      line: 0,
      entityId: "?",
      predicateId: "?",
      rule: "duplicate-predicate-id",
      message: msg,
    });
  }

  /** Resolve predicate, following alias_of if present. Returns [resolved, aliasedFrom] */
  function resolvePredicate(id: string): [Predicate | undefined, string | undefined] {
    const pred = predicateIndex.get(id);
    if (!pred) return [undefined, undefined];
    if (pred.alias_of) {
      const canonical = predicateIndex.get(pred.alias_of);
      return [canonical, id];
    }
    return [pred, undefined];
  }

  // Build entity owner map — ERROR on duplicate entity id across lenses
  const entityOwner = new Map<string, string>(); // entity id -> lens id that owns it
  const entityOwnerLine = new Map<string, number>(); // entity id -> line number in owning lens
  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    for (const { record: entity, file, line } of lens.entities) {
      if (entityOwner.has(entity.id)) {
        const ownerLens = entityOwner.get(entity.id)!;
        const ownerLine = entityOwnerLine.get(entity.id)!;
        violations.push({
          severity: "error",
          lens: lensId,
          file,
          line,
          entityId: entity.id,
          predicateId: "?",
          rule: "duplicate-entity-id",
          message: `Entity id '${entity.id}' also appears in lens '${ownerLens}' (line ${ownerLine}). Entity ids must be globally unique across all lenses.`,
        });
      } else {
        entityOwner.set(entity.id, lensId);
        entityOwnerLine.set(entity.id, line);
      }
    }
  }

  // Build source id sets per lens
  const sourceIds = new Map<string, Set<string>>(); // lens -> set of source ids
  const allSourceIds = new Set<string>();
  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    const ids = new Set<string>();
    for (const { record: src } of lens.sources) {
      ids.add(src.id);
      allSourceIds.add(src.id);
    }
    sourceIds.set(lensId, ids);
  }

  // Per-lens validation
  for (const lensId of lensSet.order) {
    // If targetLens specified, only validate entities/predicates from those lenses
    // (but we still need all data for transitive checks)
    const isTargeted = !targetLens || targetLens.has(lensId);

    const lens = lensSet.lenses.get(lensId)!;
    const manifest = lens.manifest;

    let lensErrors = 0;
    let lensWarnings = 0;

    const countViolationsBefore = violations.length;

    if (isTargeted) {
      // Validate predicates in this lens
      for (const { record: pred, file, line } of lens.predicates) {
        // Basic field checks happen via schema validator; here we do semantic checks
        if (pred.lens !== lensId) {
          violation("error", lensId, file, line, pred.id, pred.id, "predicate-lens-mismatch",
            `predicate.lens is '${pred.lens}' but file is in lens '${lensId}'`);
        }
      }

      // Validate entities in this lens
      for (const { record: entity, file, line } of lens.entities) {
        const isClass = isInstanceOf(graph, entity.id, "meta:class");

        // Cardinality check: gather all statements on this entity across all lenses
        const mergedEntity = graph.entities.get(entity.id);
        const allStatements = mergedEntity ? mergedEntity.statements : entity.statements;

        // Multi-class preferred-rank warning: if entity has >1 instance_of statements, none with rank=preferred
        const instanceOfEntries = (entity.statements["instance_of"] ?? []).filter(e => e.rank !== "deprecated");
        if (instanceOfEntries.length > 1) {
          const hasPreferred = instanceOfEntries.some(e => e.rank === "preferred");
          if (!hasPreferred) {
            violation("warning", lensId, file, line, entity.id, "instance_of", "multi-class-no-preferred-rank",
              `entity has ${instanceOfEntries.length} instance_of statements but none has rank: "preferred" — add preferred rank to disambiguate primary class`);
          }
        }

        // We only check statements that appear in THIS lens's entity record
        for (const [predId, entries] of Object.entries(entity.statements)) {
          const [pred, aliasedFrom] = resolvePredicate(predId);

          // 1. Unknown predicate
          if (!pred) {
            violation("warning", lensId, file, line, entity.id, predId, "unknown-predicate",
              `predicate '${predId}' is not defined in any loaded lens`);
            continue;
          }

          // Alias usage info
          if (aliasedFrom) {
            violations.push({
              severity: "info",
              lens: lensId,
              file,
              line,
              entityId: entity.id,
              predicateId: predId,
              rule: "alias-usage",
              message: `predicate '${predId}' is an alias of '${pred.id}'; using canonical constraints`,
            });
          }

          // Deprecated predicate warning (per use, for each non-deprecated statement)
          if (pred.deprecated) {
            for (const entry of entries) {
              if (entry.rank !== "deprecated") {
                violation("warning", lensId, file, line, entity.id, predId, "deprecated-predicate",
                  `predicate '${predId}' is deprecated — see predicate description for successor`);
              }
            }
          }

          for (const entry of entries) {
            const { value, source, rank } = entry;

            // Skip deprecated statements for most checks (cardinality excluded, done separately)
            if (rank === "deprecated") continue;

            // Sentinel: skip value-type, value-pattern, range checks entirely
            if (isSentinel(value)) {
              // Still do source check and domain check below, but skip type/range
              // Domain check
              if (pred.domain && pred.domain.length > 0) {
                const isStructural = (predId === "instance_of" || predId === "subclass_of") && isClass;
                if (!isStructural) {
                  const domainOk = pred.domain.some((dc) => isInstanceOf(graph, entity.id, dc.slice(1)));
                  if (!domainOk) {
                    violation("error", lensId, file, line, entity.id, predId, "domain-violation",
                      `entity '${entity.id}' must be instance_of one of [${pred.domain.join(", ")}] to use predicate '${predId}'`);
                  }
                }
              }
              // Source check
              const ownerLensIdS = entityOwner.get(entity.id) ?? lensId;
              const ownerManifestS = lensSet.lenses.get(ownerLensIdS)?.manifest;
              if (ownerManifestS?.source_required) {
                const isStructuralOnClass = isClass && (predId === "instance_of" || predId === "subclass_of");
                if (!isStructuralOnClass) {
                  if (source == null) {
                    violation("error", lensId, file, line, entity.id, predId, "source-required",
                      `lens '${ownerLensIdS}' requires sources, but statement has no source`);
                  } else if (!allSourceIds.has(source)) {
                    violation("error", lensId, file, line, entity.id, predId, "dangling-source-ref",
                      `source '${source}' not found in any lens's sources.jsonl`);
                  }
                }
              }
              continue;
            }

            // 2. Value type check
            const typeErr = checkValueType(value as string | number | boolean, pred);
            if (typeErr) {
              violation("error", lensId, file, line, entity.id, predId, "value-type",
                `${typeErr}`);
            }

            // 3. Entity ref resolution
            if (pred.value_type === "entity" && typeof value === "string" && value.startsWith("@")) {
              const refId = value.slice(1);
              const refEntity = graph.entities.get(refId);

              if (!refEntity) {
                violation("error", lensId, file, line, entity.id, predId, "dangling-entity-ref",
                  `entity ref '${value}' does not exist in any loaded lens`);
              } else {
                // 4. Range check
                if (pred.range && pred.range.length > 0) {
                  const rangeOk = pred.range.some((rc) => isInstanceOf(graph, refId, rc.slice(1)));
                  if (!rangeOk) {
                    violation("error", lensId, file, line, entity.id, predId, "range-violation",
                      `'${value}' must be instance_of one of [${pred.range.join(", ")}] but is not`);
                  }
                }

                // 5. Cross-lens fictional reference warning
                const refOwnerLens = entityOwner.get(refId);
                const refOwnerManifest = refOwnerLens ? lensSet.lenses.get(refOwnerLens)?.manifest : undefined;
                if (
                  manifest.register === "factual" &&
                  refOwnerManifest &&
                  (refOwnerManifest.register === "fictional" || refOwnerManifest.register === "interpretive")
                ) {
                  violation("warning", lensId, file, line, entity.id, predId, "cross-lens-fictional-ref",
                    `factual lens '${lensId}' references entity '${value}' owned by ${refOwnerManifest.register} lens '${refOwnerLens}'`);
                }
              }
            }

            // 6. Domain check
            if (pred.domain && pred.domain.length > 0) {
              // Exception: structural predicates on class entities
              const isStructural = (predId === "instance_of" || predId === "subclass_of") && isClass;
              if (!isStructural) {
                const domainOk = pred.domain.some((dc) => isInstanceOf(graph, entity.id, dc.slice(1)));
                if (!domainOk) {
                  violation("error", lensId, file, line, entity.id, predId, "domain-violation",
                    `entity '${entity.id}' must be instance_of one of [${pred.domain.join(", ")}] to use predicate '${predId}'`);
                }
              }
            }

            // 7. Source check (per owning lens rule, but check using the statement's lens context)
            // Source rule: if the lens that OWNS the entity has source_required=true,
            // each statement must have a source EXCEPT structural predicates on class entities
            const ownerLensId = entityOwner.get(entity.id) ?? lensId;
            const ownerManifest = lensSet.lenses.get(ownerLensId)?.manifest;
            if (ownerManifest?.source_required) {
              const isStructuralOnClass = isClass && (predId === "instance_of" || predId === "subclass_of");
              if (!isStructuralOnClass) {
                if (source == null) {
                  violation("error", lensId, file, line, entity.id, predId, "source-required",
                    `lens '${ownerLensId}' requires sources, but statement has no source`);
                } else if (!allSourceIds.has(source)) {
                  violation("error", lensId, file, line, entity.id, predId, "dangling-source-ref",
                    `source '${source}' not found in any lens's sources.jsonl`);
                }
              }
            }

            // Qualifier entity refs
            if (entry.qualifiers) {
              for (const [qPred, qVal] of Object.entries(entry.qualifiers)) {
                if (typeof qVal === "string" && qVal.startsWith("@")) {
                  const refId = qVal.slice(1);
                  if (!graph.entities.has(refId)) {
                    violation("error", lensId, file, line, entity.id, predId, "dangling-qualifier-ref",
                      `dangling entity ref '${qVal}' in qualifier '${qPred}'`);
                  }
                }
              }
            }
          }

          // 8. Cardinality check (using merged statements, counted over non-deprecated)
          // Sentinel values count as 1 satisfied statement
          if (pred.cardinality) {
            const { min, max } = parseCardinality(pred.cardinality);
            const mergedEntries = allStatements[predId] ?? [];
            const activeCount = mergedEntries.filter((e) => e.rank !== "deprecated").length;
            if (activeCount < min) {
              violation("error", lensId, file, line, entity.id, predId, "cardinality-violation",
                `cardinality '${pred.cardinality}' requires min ${min} statements, found ${activeCount}`);
            }
            if (max !== null && activeCount > max) {
              violation("error", lensId, file, line, entity.id, predId, "cardinality-violation",
                `cardinality '${pred.cardinality}' allows max ${max} statements, found ${activeCount}`);
            }
          }
        }
      }
    }

    // Count violations attributed to this lens (info messages not counted)
    for (let i = countViolationsBefore; i < violations.length; i++) {
      if (violations[i].severity === "error") lensErrors++;
      else if (violations[i].severity === "warning") lensWarnings++;
    }

    summaries.push({
      lensId,
      entities: lens.entities.length,
      predicates: lens.predicates.length,
      sources: lens.sources.length,
      errors: lensErrors,
      warnings: lensWarnings,
    });
  }

  const totalErrors = violations.filter((v) => v.severity === "error").length;
  const totalWarnings = violations.filter((v) => v.severity === "warning").length;

  // Info messages don't contribute to error/warning counts but are included in violations
  return { violations, summaries, totalErrors, totalWarnings };
}
