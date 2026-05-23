/**
 * Pure SHACL-lite validation logic.
 * No I/O — takes a LoadedLensSet and returns violations.
 */

import { LoadedLensSet, Entity, Predicate, LensManifest, isSentinel, ExtensionRecord } from "./load.ts";
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

  // Surface any cycle violations from topoSort
  for (const msg of lensSet.cycleViolations) {
    violations.push({
      severity: "error",
      lens: "global",
      file: "(manifest)",
      line: 0,
      entityId: "?",
      predicateId: "?",
      rule: "lens-dependency-cycle",
      message: msg,
    });
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

  /** Resolve predicate, following alias_of chains up to 5 hops. Returns [resolved, aliasedFrom] */
  function resolvePredicate(id: string): [Predicate | undefined, string | undefined] {
    const pred = predicateIndex.get(id);
    if (!pred) return [undefined, undefined];
    if (!pred.alias_of) return [pred, undefined];

    // Check for self-alias
    if (pred.alias_of === pred.id) {
      violations.push({
        severity: "error",
        lens: predicateLens.get(id) ?? "global",
        file: "(predicate index)",
        line: 0,
        entityId: "?",
        predicateId: id,
        rule: "self-alias",
        message: `predicate '${id}' has alias_of pointing to itself`,
      });
      return [undefined, id];
    }

    // Follow chain up to 5 hops
    let current = pred;
    let hops = 0;
    const firstAlias = id;
    while (current.alias_of) {
      hops++;
      if (hops > 5) {
        violations.push({
          severity: "error",
          lens: predicateLens.get(id) ?? "global",
          file: "(predicate index)",
          line: 0,
          entityId: "?",
          predicateId: id,
          rule: "alias-chain-too-long",
          message: `predicate '${id}' alias_of chain exceeds 5 hops`,
        });
        return [undefined, firstAlias];
      }
      const next = predicateIndex.get(current.alias_of);
      if (!next) {
        // dangling alias target — let the "unknown predicate" path handle it
        return [undefined, firstAlias];
      }
      if (next.id === id) {
        violations.push({
          severity: "error",
          lens: predicateLens.get(id) ?? "global",
          file: "(predicate index)",
          line: 0,
          entityId: "?",
          predicateId: id,
          rule: "alias-cycle",
          message: `predicate '${id}' alias_of forms a cycle`,
        });
        return [undefined, firstAlias];
      }
      current = next;
    }
    return [current, firstAlias];
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

      // Validate extension records in this lens
      for (const { record: ext, file, line } of lens.extensions) {
        const targetRef = ext.extends;
        const targetId = targetRef.startsWith("@") ? targetRef.slice(1) : targetRef;

        // Error if target doesn't exist
        if (!graph.entities.has(targetId)) {
          violation("error", lensId, file, line, targetId, "?", "dangling-extension",
            `extension record targets '${targetRef}' which does not exist in any loaded lens`);
          continue;
        }

        // Error if a lens extends an entity it owns
        if (entityOwner.get(targetId) === lensId) {
          violation("error", lensId, file, line, targetId, "?", "own-entity-extension",
            `lens '${lensId}' owns entity '${targetId}' — use the definition record instead of an extension`);
          continue;
        }

        // Source policy: use OWNING lens's source_required (not extending lens's)
        const targetOwnerLensId = entityOwner.get(targetId) ?? lensId;
        const targetOwnerManifest = lensSet.lenses.get(targetOwnerLensId)?.manifest;
        const extSourceRequired = targetOwnerManifest?.source_required ?? false;

        const isTargetClass = isInstanceOf(graph, targetId, "meta:class");

        // Validate extension statements at parity with definition records
        for (const [predId, entries] of Object.entries(ext.statements)) {
          const [pred, aliasedFrom] = resolvePredicate(predId);
          if (!pred) {
            violation("warning", lensId, file, line, targetId, predId, "unknown-predicate",
              `predicate '${predId}' in extension record is not defined in any loaded lens`);
            continue;
          }

          // Alias usage info
          if (aliasedFrom) {
            violations.push({
              severity: "info",
              lens: lensId,
              file,
              line,
              entityId: targetId,
              predicateId: predId,
              rule: "alias-usage",
              message: `predicate '${predId}' is an alias of '${pred.id}'; using canonical constraints`,
            });
          }

          for (const entry of entries) {
            const { value, source, rank } = entry;
            if (rank === "deprecated") continue;

            if (isSentinel(value)) {
              // Domain check
              if (pred.domain && pred.domain.length > 0) {
                const isStructural = (predId === "instance_of" || predId === "subclass_of") && isTargetClass;
                if (!isStructural) {
                  const domainOk = pred.domain.some((dc) => isInstanceOf(graph, targetId, dc.slice(1)));
                  if (!domainOk) {
                    violation("error", lensId, file, line, targetId, predId, "domain-violation",
                      `entity '${targetId}' must be instance_of one of [${pred.domain.join(", ")}] to use predicate '${predId}'`);
                  }
                }
              }
              // Source check using OWNING lens's source_required
              if (extSourceRequired) {
                const isStructuralOnClass = isTargetClass && (predId === "instance_of" || predId === "subclass_of");
                if (!isStructuralOnClass) {
                  if (source == null) {
                    violation("error", lensId, file, line, targetId, predId, "source-required",
                      `lens '${targetOwnerLensId}' (owner) requires sources, but extension statement has no source`);
                  } else if (!allSourceIds.has(source)) {
                    violation("error", lensId, file, line, targetId, predId, "dangling-source-ref",
                      `source '${source}' not found in any lens's sources.jsonl`);
                  }
                }
              }
              continue;
            }

            // Value type check
            const typeErr = checkValueType(value as string | number | boolean, pred);
            if (typeErr) {
              violation("error", lensId, file, line, targetId, predId, "value-type", typeErr);
            }

            // Entity ref resolution + range check + cross-lens fictional warning
            if (pred.value_type === "entity" && typeof value === "string" && value.startsWith("@")) {
              const refId = value.slice(1);
              const refEntity = graph.entities.get(refId);
              if (!refEntity) {
                violation("error", lensId, file, line, targetId, predId, "dangling-entity-ref",
                  `entity ref '${value}' in extension record does not exist`);
              } else {
                // Range check
                if (pred.range && pred.range.length > 0) {
                  const rangeOk = pred.range.some((rc) => isInstanceOf(graph, refId, rc.slice(1)));
                  if (!rangeOk) {
                    violation("error", lensId, file, line, targetId, predId, "range-violation",
                      `'${value}' must be instance_of one of [${pred.range.join(", ")}] but is not`);
                  }
                }

                // Cross-lens fictional reference warning
                const refOwnerLens = entityOwner.get(refId);
                const refOwnerManifest = refOwnerLens ? lensSet.lenses.get(refOwnerLens)?.manifest : undefined;
                if (
                  manifest.register === "factual" &&
                  refOwnerManifest &&
                  (refOwnerManifest.register === "fictional" || refOwnerManifest.register === "interpretive")
                ) {
                  violation("warning", lensId, file, line, targetId, predId, "cross-lens-fictional-ref",
                    `factual lens '${lensId}' references entity '${value}' owned by ${refOwnerManifest.register} lens '${refOwnerLens}'`);
                }
              }
            }

            // Domain check
            if (pred.domain && pred.domain.length > 0) {
              const isStructural = (predId === "instance_of" || predId === "subclass_of") && isTargetClass;
              if (!isStructural) {
                const domainOk = pred.domain.some((dc) => isInstanceOf(graph, targetId, dc.slice(1)));
                if (!domainOk) {
                  violation("error", lensId, file, line, targetId, predId, "domain-violation",
                    `entity '${targetId}' must be instance_of one of [${pred.domain.join(", ")}] to use predicate '${predId}'`);
                }
              }
            }

            // Source check using OWNING lens's source_required
            if (extSourceRequired) {
              const isStructuralOnClass = isTargetClass && (predId === "instance_of" || predId === "subclass_of");
              if (!isStructuralOnClass) {
                if (source == null) {
                  violation("error", lensId, file, line, targetId, predId, "source-required",
                    `lens '${targetOwnerLensId}' (owner) requires sources, but extension statement has no source`);
                } else if (!allSourceIds.has(source)) {
                  violation("error", lensId, file, line, targetId, predId, "dangling-source-ref",
                    `source '${source}' not found in any lens's sources.jsonl`);
                }
              }
            }

            // Qualifier validation
            if (entry.qualifiers) {
              for (const [qPredId, qVal] of Object.entries(entry.qualifiers)) {
                const qPredDef = predicateIndex.get(qPredId);
                if (!qPredDef) {
                  violation("warning", lensId, file, line, targetId, predId, "unknown-qualifier-predicate",
                    `qualifier key '${qPredId}' is not a defined predicate`);
                  if (typeof qVal === "string" && qVal.startsWith("@")) {
                    const refId = qVal.slice(1);
                    if (!graph.entities.has(refId)) {
                      violation("error", lensId, file, line, targetId, predId, "dangling-qualifier-ref",
                        `dangling entity ref '${qVal}' in qualifier '${qPredId}'`);
                    }
                  }
                  continue;
                }
                const qTypeErr = checkValueType(qVal as string | number | boolean, qPredDef);
                if (qTypeErr) {
                  violation("error", lensId, file, line, targetId, predId, "qualifier-value-type",
                    `qualifier '${qPredId}': ${qTypeErr}`);
                }
                if (typeof qVal === "string" && qVal.startsWith("@")) {
                  const refId = qVal.slice(1);
                  if (!graph.entities.has(refId)) {
                    violation("error", lensId, file, line, targetId, predId, "dangling-qualifier-ref",
                      `dangling entity ref '${qVal}' in qualifier '${qPredId}'`);
                  }
                }
              }
            }
          }
        }

        // Multi-class preferred-rank warning for merged instance_of (extensions contribute)
        const mergedExtEntity = graph.entities.get(targetId);
        const mergedInstanceOf = (mergedExtEntity?.statements["instance_of"] ?? []).filter(e => e.rank !== "deprecated");
        // Only check extensions that ADD instance_of statements
        const extInstanceOf = (ext.statements["instance_of"] ?? []).filter(e => e.rank !== "deprecated");
        if (extInstanceOf.length > 0 && mergedInstanceOf.length > 1) {
          const hasPreferred = mergedInstanceOf.some(e => e.rank === "preferred");
          if (!hasPreferred) {
            violation("warning", lensId, file, line, targetId, "instance_of", "multi-class-no-preferred-rank",
              `entity has ${mergedInstanceOf.length} merged instance_of statements (including extension) but none has rank: "preferred"`);
          }
          const preferredCount = mergedInstanceOf.filter(e => e.rank === "preferred").length;
          if (preferredCount > 1) {
            violation("error", lensId, file, line, targetId, "instance_of", "multi-preferred-instance-of",
              `entity has ${preferredCount} merged instance_of statements with rank: "preferred" — at most one may be preferred`);
          }
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
          // Multi-preferred error: more than one with rank=preferred
          const preferredCount = instanceOfEntries.filter(e => e.rank === "preferred").length;
          if (preferredCount > 1) {
            violation("error", lensId, file, line, entity.id, "instance_of", "multi-preferred-instance-of",
              `entity has ${preferredCount} instance_of statements with rank: "preferred" — at most one may be preferred`);
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

            // Qualifier validation
            if (entry.qualifiers) {
              for (const [qPredId, qVal] of Object.entries(entry.qualifiers)) {
                // 1. Qualifier key must be a known predicate (warn if not)
                const qPredDef = predicateIndex.get(qPredId);
                if (!qPredDef) {
                  violation("warning", lensId, file, line, entity.id, predId, "unknown-qualifier-predicate",
                    `qualifier key '${qPredId}' is not a defined predicate`);
                  // Still check entity ref resolution for unknown predicates
                  if (typeof qVal === "string" && qVal.startsWith("@")) {
                    const refId = qVal.slice(1);
                    if (!graph.entities.has(refId)) {
                      violation("error", lensId, file, line, entity.id, predId, "dangling-qualifier-ref",
                        `dangling entity ref '${qVal}' in qualifier '${qPredId}'`);
                    }
                  }
                  continue;
                }

                // 2. Qualifier value type check
                const qTypeErr = checkValueType(qVal as string | number | boolean, qPredDef);
                if (qTypeErr) {
                  violation("error", lensId, file, line, entity.id, predId, "qualifier-value-type",
                    `qualifier '${qPredId}': ${qTypeErr}`);
                }

                // 3. Entity ref qualifier values must resolve (no domain/range on qualifiers)
                if (typeof qVal === "string" && qVal.startsWith("@")) {
                  const refId = qVal.slice(1);
                  if (!graph.entities.has(refId)) {
                    violation("error", lensId, file, line, entity.id, predId, "dangling-qualifier-ref",
                      `dangling entity ref '${qVal}' in qualifier '${qPredId}'`);
                  }
                }
              }
            }
          }

          // 8a. Multi-preferred-rank check: at most one preferred per predicate (any predicate, not just instance_of)
          if (predId !== "instance_of") {
            // instance_of is already checked above with the multi-class warning
            const activeEntries = entries.filter(e => e.rank !== "deprecated");
            const preferredCount = activeEntries.filter(e => e.rank === "preferred").length;
            if (preferredCount > 1) {
              violation("error", lensId, file, line, entity.id, predId, "multi-preferred-rank",
                `predicate '${predId}' has ${preferredCount} statements with rank: "preferred" — at most one may be preferred per predicate`);
            }
          }

          // 8. Cardinality check (using merged statements, counted over non-deprecated)
          // Sentinel values count toward MAX but NOT MIN:
          // real_count = non-deprecated non-sentinel entries (used for min check)
          // total_count = non-deprecated entries including sentinels (used for max check)
          if (pred.cardinality) {
            const { min, max } = parseCardinality(pred.cardinality);
            const mergedEntries = allStatements[predId] ?? [];
            const activeEntries = mergedEntries.filter((e) => e.rank !== "deprecated");
            const real_count = activeEntries.filter((e) => !isSentinel(e.value)).length;
            const total_count = activeEntries.length;
            if (real_count < min) {
              violation("error", lensId, file, line, entity.id, predId, "cardinality-violation",
                `cardinality '${pred.cardinality}' requires min ${min} real values, found ${real_count} (sentinels do not satisfy minimum)`);
            }
            if (max !== null && total_count > max) {
              violation("error", lensId, file, line, entity.id, predId, "cardinality-violation",
                `cardinality '${pred.cardinality}' allows max ${max} statements, found ${total_count}`);
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
      entities: lens.entities.length + lens.extensions.length,
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
