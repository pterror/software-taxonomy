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

// ---- Per-statement validation (shared between definition and extension paths) ----

interface StatementContext {
  /** Lens in which this statement physically appears */
  lensId: string;
  manifest: LensManifest;
  /** Whether this statement came from an extension record */
  fromExtension: boolean;
  /** Lens that OWNS the entity (governs source_required policy) */
  ownerLensId: string;
  ownerManifest: LensManifest | undefined;
  /** Whether the owning lens requires sources */
  sourceRequired: boolean;
  /** Whether the subject entity is a class */
  isClass: boolean;
  file: string;
  line: number;
}

/**
 * Validates qualifier key/value pairs for a statement.
 * - Sentinel values ({unknown:true}, {novalue:true}) are accepted for any qualifier predicate.
 * - Entity ref values (@<id>) must resolve when the qualifier predicate has value_type=entity.
 * - Otherwise standard value-type checking applies.
 */
function validateQualifiers(
  graph: Graph,
  predicateIndex: Map<string, Predicate>,
  violations: Violation[],
  subjectId: string,
  predId: string,
  qualifiers: Record<string, string | number | boolean | import("./load.ts").SentinelValue>,
  ctx: StatementContext
): void {
  function violation(severity: Severity, rule: string, message: string) {
    violations.push({ severity, lens: ctx.lensId, file: ctx.file, line: ctx.line, entityId: subjectId, predicateId: predId, rule, message });
  }

  for (const [qPredId, qVal] of Object.entries(qualifiers)) {
    // Sentinels are accepted for any qualifier predicate — skip all further checks
    if (isSentinel(qVal)) continue;

    const qPredDef = predicateIndex.get(qPredId);
    if (!qPredDef) {
      violation("warning", "unknown-qualifier-predicate",
        `qualifier key '${qPredId}' is not a defined predicate`);
      // Still check entity ref resolution for unknown predicates
      if (typeof qVal === "string" && qVal.startsWith("@")) {
        const refId = qVal.slice(1);
        if (!graph.entities.has(refId)) {
          violation("error", "dangling-qualifier-ref",
            `dangling entity ref '${qVal}' in qualifier '${qPredId}'`);
        }
      }
      continue;
    }

    // Value type check
    const qTypeErr = checkValueType(qVal as string | number | boolean, qPredDef);
    if (qTypeErr) {
      violation("error", "qualifier-value-type", `qualifier '${qPredId}': ${qTypeErr}`);
    }

    // Entity ref: must resolve when qualifier predicate is value_type=entity
    if (typeof qVal === "string" && qVal.startsWith("@")) {
      const refId = qVal.slice(1);
      if (!graph.entities.has(refId)) {
        violation("error", "dangling-qualifier-ref",
          `dangling entity ref '${qVal}' in qualifier '${qPredId}'`);
      }
    } else if (qPredDef.value_type === "entity" && typeof qVal === "string" && !qVal.startsWith("@")) {
      violation("error", "qualifier-value-type",
        `qualifier '${qPredId}': expected entity reference (starting with @), got '${qVal}'`);
    }
  }
}

/**
 * Validates a single statement entry against its predicate and context.
 * Returns violations. Does NOT validate cardinality (that requires all entries).
 * Does NOT skip deprecated — callers may pre-filter if needed.
 */
function validateStatementEntry(
  graph: Graph,
  predicateIndex: Map<string, Predicate>,
  allSourceIds: Set<string>,
  violations: Violation[],
  subjectId: string,
  predId: string,
  pred: Predicate,
  entry: import("./load.ts").StatementEntry,
  ctx: StatementContext
): void {
  function violation(
    severity: Severity,
    rule: string,
    message: string
  ) {
    violations.push({ severity, lens: ctx.lensId, file: ctx.file, line: ctx.line, entityId: subjectId, predicateId: predId, rule, message });
  }

  const { value, source, rank } = entry;

  // Deprecated statements skip domain/range/cardinality/source checks (historical truth),
  // but qualifier shape validation still runs — even deprecated statements must have valid qualifiers.
  if (rank === "deprecated") {
    if (entry.qualifiers) {
      validateQualifiers(graph, predicateIndex, violations, subjectId, predId, entry.qualifiers, ctx);
    }
    // Warn if deprecated statement has no end_time qualifier — historical claim is open-ended
    if (!entry.qualifiers?.end_time) {
      violation("warning", "deprecated-no-end-time",
        `deprecated statement on predicate '${predId}' has no end_time qualifier — add end_time to indicate when this relationship ended`);
    }
    return;
  }

  // Sentinel: skip value-type, value-pattern, range checks entirely
  // Domain check migrated to Datalog.
  if (isSentinel(value)) {
    // Source check using OWNING lens's source_required (dangling-source-ref migrated to Datalog)
    if (ctx.sourceRequired) {
      const isStructuralOnClass = ctx.isClass && (predId === "instance_of" || predId === "subclass_of");
      if (!isStructuralOnClass) {
        if (source == null) {
          violation("error", "source-required",
            `lens '${ctx.ownerLensId}' (owner) requires sources, but ${ctx.fromExtension ? "extension " : ""}statement has no source`);
        }
      }
    }
    return;
  }

  // end-without-start warning: end_time qualifier without start_time is meaningless
  if (entry.qualifiers?.end_time && !entry.qualifiers?.start_time) {
    violation("warning", "end-without-start",
      `statement on predicate '${predId}' has end_time qualifier but no start_time — add start_time or remove end_time`);
  }

  // Value type check
  const typeErr = checkValueType(value as string | number | boolean, pred);
  if (typeErr) {
    violation("error", "value-type", `${typeErr}`);
  }

  // Domain and range checks migrated to Datalog.

  // Source check using OWNING lens's source_required (dangling-source-ref migrated to Datalog)
  if (ctx.sourceRequired) {
    const isStructuralOnClass = ctx.isClass && (predId === "instance_of" || predId === "subclass_of");
    if (!isStructuralOnClass) {
      if (source == null) {
        violation("error", "source-required",
          `lens '${ctx.ownerLensId}' (owner) requires sources, but ${ctx.fromExtension ? "extension " : ""}statement has no source`);
      }
    }
  }

  // Qualifier validation
  if (entry.qualifiers) {
    validateQualifiers(graph, predicateIndex, violations, subjectId, predId, entry.qualifiers, ctx);
  }
}

// ---- Main validation ----

export function validate(lensSet: LoadedLensSet, targetLens?: Set<string>): ValidationResult {
  clearTransitiveCache();

  // Build graph from full lens set (all loaded lenses — needed for transitive checks)
  // Pass the already-loaded lensSet to avoid a redundant second disk read
  const graph = buildGraph(undefined, lensSet);

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

  // Build entity owner map (duplicate-entity-id check migrated to Datalog)
  const entityOwner = new Map<string, string>(); // entity id -> lens id that owns it
  const entityOwnerLine = new Map<string, number>(); // entity id -> line number in owning lens
  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    for (const { record: entity, file, line } of lens.entities) {
      if (!entityOwner.has(entity.id)) {
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
            const ctx: StatementContext = {
              lensId,
              manifest,
              fromExtension: true,
              ownerLensId: targetOwnerLensId,
              ownerManifest: targetOwnerManifest,
              sourceRequired: extSourceRequired,
              isClass: isTargetClass,
              file,
              line,
            };
            validateStatementEntry(graph, predicateIndex, allSourceIds, violations, targetId, predId, pred, entry, ctx);

            // Cross-lens fictional reference warning (needs lensSet, done inline)
            const { value } = entry;
            if (entry.rank !== "deprecated" && !isSentinel(value) &&
                pred.value_type === "entity" && typeof value === "string" && value.startsWith("@")) {
              const refId = value.slice(1);
              if (graph.entities.has(refId)) {
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
          }
        }

        // multi-preferred/no-preferred-rank for instance_of migrated to Datalog
      }

      // Validate entities in this lens
      for (const { record: entity, file, line } of lens.entities) {
        const isClass = isInstanceOf(graph, entity.id, "meta:class");

        // multi-class-no-preferred-rank, multi-preferred-instance-of, cardinality migrated to Datalog

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
            const ctx: StatementContext = {
              lensId,
              manifest,
              fromExtension: false,
              ownerLensId: entityOwner.get(entity.id) ?? lensId,
              ownerManifest: lensSet.lenses.get(entityOwner.get(entity.id) ?? lensId)?.manifest,
              sourceRequired: lensSet.lenses.get(entityOwner.get(entity.id) ?? lensId)?.manifest?.source_required ?? false,
              isClass,
              file,
              line,
            };
            validateStatementEntry(graph, predicateIndex, allSourceIds, violations, entity.id, predId, pred, entry, ctx);

            // Cross-lens fictional reference warning (needs lensSet, done inline)
            const { value } = entry;
            if (entry.rank !== "deprecated" && !isSentinel(value) &&
                pred.value_type === "entity" && typeof value === "string" && value.startsWith("@")) {
              const refId = value.slice(1);
              if (graph.entities.has(refId)) {
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
          }

          // multi-preferred-rank, no-preferred-rank, and cardinality migrated to Datalog
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
