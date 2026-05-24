/**
 * Datalog harness for the software-taxonomy validator.
 *
 * - emitFacts: serializes a LoadedLensSet to Ascent fact syntax
 * - runDatalog: spawns ascent-interpreter, parses violation tuples from stdout
 * - enrichViolations: attaches file:line provenance to raw Datalog violations
 */

import { resolve, join } from "path";
import { existsSync } from "fs";
import { __dirname } from "./load.ts";
import type { LoadedLensSet, Entity, StatementEntry } from "./load.ts";
import type { Severity, Violation } from "./validate-lib.ts";
import { isSentinel } from "./load.ts";

// ── Binary resolution ─────────────────────────────────────────────────────────

/** Resolve the ascent-interpreter binary path. Checks PATH first, then the known build location. */
function resolveInterpreterBin(): string {
  // Allow override via env var
  const envPath = process.env["ASCENT_INTERPRETER"];
  if (envPath) return envPath;

  // Check PATH (set by nix develop shell)
  // Bun doesn't have a `which` built-in; we check via spawn
  const knownPath = "/home/me/git/ascent-interpreter/target/release/ascent-interpreter";
  if (existsSync(knownPath)) return knownPath;

  throw new Error(
    "ascent-interpreter binary not found. " +
    "Either enter `nix develop` (which puts it on PATH) or set ASCENT_INTERPRETER=/path/to/binary."
  );
}

// ── String escaping ───────────────────────────────────────────────────────────

function escStr(s: string): string {
  // Escape backslashes and double quotes for Ascent string literals
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
}

function valToStr(v: unknown): string {
  if (typeof v === "string") return escStr(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  return escStr(String(v));
}

// ── Provenance map ────────────────────────────────────────────────────────────

/** stmt_id → {file, line, lensId} for statement-keyed violations */
export type ProvenanceMap = Map<string, { file: string; line: number; lensId: string }>;
/** predicate_id → {file, line, lensId} for predicate-keyed violations */
export type PredicateProvenanceMap = Map<string, { file: string; line: number; lensId: string }>;
/** lens_id → {manifestPath} for lens-keyed violations */
export type LensProvenanceMap = Map<string, { manifestPath: string }>;

export interface ProvenanceMaps {
  stmt: ProvenanceMap;
  predicate: PredicateProvenanceMap;
  lens: LensProvenanceMap;
}

// ── Facts emission ─────────────────────────────────────────────────────────────

/**
 * Serialize a LoadedLensSet to Ascent fact syntax.
 * Returns { facts, provenance } where provenance contains maps for stmt, predicate, and lens.
 *
 * Statement facts use stmt_id = "<entity_id>#<predicate_id>#<index>" as primary key.
 * This ensures source_required checks (and all other per-statement checks) work correctly
 * even when multiple statements share the same (entity, predicate, rank) bucket.
 */
export function emitFacts(lensSet: LoadedLensSet): { facts: string; provenance: ProvenanceMaps } {
  const lines: string[] = [];
  const stmtProv: ProvenanceMap = new Map();
  const predicateProv: PredicateProvenanceMap = new Map();
  const lensProv: LensProvenanceMap = new Map();

  function fact(rel: string, ...args: string[]): void {
    lines.push(`${rel}(${args.join(", ")});`);
  }

  // entity(id, owner_lens) — deduplicated by Datalog; used for existence checks
  // entity_def(id, lens, line_str) — one fact per definition; line_str makes duplicates visible
  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    // Lens provenance
    lensProv.set(lensId, { manifestPath: lens.manifestPath });
    for (const { record: entity, file, line } of lens.entities) {
      fact("entity", escStr(entity.id), escStr(lensId));
      fact("entity_def", escStr(entity.id), escStr(lensId), escStr(String(line)));
      // Store provenance keyed by entity id (first occurrence wins)
      if (!stmtProv.has(`entity#${entity.id}`)) {
        stmtProv.set(`entity#${entity.id}`, { file, line, lensId });
      }
    }
  }

  // entity_owner(entity_id, owner_lens_id, source_required)
  // Also emit lens(id, register, source_required)
  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    const srcReq = escStr(String(lens.manifest.source_required ?? false));
    fact("lens", escStr(lensId), escStr(lens.manifest.register), srcReq);
    // entity_owner is emitted per entity
    for (const { record: entity } of lens.entities) {
      fact("entity_owner", escStr(entity.id), escStr(lensId), srcReq);
    }
  }

  // predicate_def and domain/range
  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    for (const { record: pred, file, line } of lens.predicates) {
      const [min, max] = parseCardinality(pred.cardinality ?? "0..*");
      const expectPreferred = escStr(String(pred.expect_preferred !== false));
      fact("predicate_def",
        escStr(pred.id), escStr(pred.value_type),
        String(min), String(max),
        expectPreferred, escStr(lensId)
      );
      // Predicate provenance
      if (!predicateProv.has(pred.id)) {
        predicateProv.set(pred.id, { file, line, lensId });
      }
      if (pred.alias_of) {
        fact("predicate_alias", escStr(pred.id), escStr(pred.alias_of));
      }
      for (const d of (pred.domain ?? [])) {
        const classId = d.startsWith("@") ? d.slice(1) : d;
        fact("predicate_domain", escStr(pred.id), escStr(classId));
      }
      for (const r of (pred.range ?? [])) {
        const classId = r.startsWith("@") ? r.slice(1) : r;
        fact("predicate_range", escStr(pred.id), escStr(classId));
      }
    }
  }

  // source_def(id, lens_id)
  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    for (const { record: src } of lens.sources) {
      fact("source_def", escStr(src.id), escStr(lensId));
    }
  }

  // depends_on (not needed for current rules but reserved)

  // Emit statements using stmt_id = "<entity_id>#<predicate_id>#<index>" as primary key.
  // Relations emitted:
  //   statement(stmt_id, entity_id, predicate_id, value, rank, origin_lens)
  //   stmt_src(stmt_id, source_id)
  //   entity_ref(subject, predicate, target_id, rank)   — for legacy joins
  //   is_sentinel(stmt_id)
  //   stmt_rank(subject, pred, stmt_id, rank)           — for qualifier rules
  //   has_qualifier(subject, pred, stmt_id, q_pred)
  //   qualifier_entity_ref(subject, pred, stmt_id, q_pred, target_id)
  function emitStatements(
    subjectId: string,
    statements: Record<string, StatementEntry[]>,
    originLensId: string,
    file: string,
    line: number
  ): void {
    for (const [predId, entries] of Object.entries(statements)) {
      for (let idx = 0; idx < entries.length; idx++) {
        const entry = entries[idx];
        const rank = entry.rank ?? "normal";

        // stmt_id: printable, no NUL bytes
        const stmtId = `${subjectId}#${predId}#${idx}`;

        // Provenance keyed by stmt_id
        stmtProv.set(stmtId, { file, line, lensId: originLensId });

        // Emit statement(stmt_id, entity_id, predicate_id, value, rank, origin_lens)
        // and the legacy stmt_rank (used by qualifier violation rules)
        fact("stmt_rank", escStr(subjectId), escStr(predId), escStr(stmtId), escStr(rank));

        if (isSentinel(entry.value)) {
          fact("statement", escStr(stmtId), escStr(subjectId), escStr(predId), escStr("__sentinel__"), escStr(rank), escStr(originLensId));
          fact("is_sentinel", escStr(stmtId));
          if (entry.source) {
            fact("stmt_src", escStr(stmtId), escStr(entry.source));
          }
          // Legacy stmt for counting rules
          fact("stmt", escStr(subjectId), escStr(predId), escStr("__sentinel__"), escStr(rank));
        } else if (typeof entry.value === "string" && entry.value.startsWith("@")) {
          // Entity reference — strip @ for Datalog
          const targetId = entry.value.slice(1);
          fact("statement", escStr(stmtId), escStr(subjectId), escStr(predId), escStr(entry.value), escStr(rank), escStr(originLensId));
          fact("entity_ref", escStr(subjectId), escStr(predId), escStr(targetId), escStr(rank));
          fact("stmt", escStr(subjectId), escStr(predId), escStr(entry.value), escStr(rank));
          if (entry.source) {
            fact("stmt_src", escStr(stmtId), escStr(entry.source));
          }
        } else {
          // Scalar value
          const valueStr = String(entry.value);
          fact("statement", escStr(stmtId), escStr(subjectId), escStr(predId), escStr(valueStr), escStr(rank), escStr(originLensId));
          fact("stmt", escStr(subjectId), escStr(predId), escStr(valueStr), escStr(rank));
          if (entry.source) {
            fact("stmt_src", escStr(stmtId), escStr(entry.source));
          }
        }

        // Qualifier facts: has_qualifier(subject, pred, stmt_id, q_pred)
        // qualifier_entity_ref(subject, pred, stmt_id, q_pred, target_id)
        if (entry.qualifiers) {
          for (const [qPredId, qVal] of Object.entries(entry.qualifiers)) {
            if (!isSentinel(qVal)) {
              fact("has_qualifier", escStr(subjectId), escStr(predId), escStr(stmtId), escStr(qPredId));
              if (typeof qVal === "string" && qVal.startsWith("@")) {
                const qTargetId = qVal.slice(1);
                fact("qualifier_entity_ref",
                  escStr(subjectId), escStr(predId), escStr(stmtId), escStr(qPredId), escStr(qTargetId));
              }
            }
          }
        }
      }
    }
  }

  // Emit from definition records
  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    for (const { record: entity, file, line } of lens.entities) {
      emitStatements(entity.id, entity.statements, lensId, file, line);
    }
    // Emit from extension records
    for (const { record: ext, file, line } of lens.extensions) {
      const targetId = ext.extends.startsWith("@") ? ext.extends.slice(1) : ext.extends;
      emitStatements(targetId, ext.statements, lensId, file, line);
    }
  }

  return { facts: lines.join("\n"), provenance: { stmt: stmtProv, predicate: predicateProv, lens: lensProv } };
}

function parseCardinality(card: string): [number, number] {
  const parts = card.split("..");
  if (parts.length !== 2) return [0, -1];
  const min = parseInt(parts[0], 10) || 0;
  const max = parts[1] === "*" ? -1 : (parseInt(parts[1], 10) || 0);
  return [min, max];
}

// ── Datalog output parsing ────────────────────────────────────────────────────

export interface RawViolation {
  rule: string;
  /** Ordered tuple values as strings (without outer quotes) */
  args: string[];
}

/** Parse a tuple line like `  ("a", "b", "c")` into an array of strings. */
function parseTupleLine(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return null;
  const inner = trimmed.slice(1, -1);
  const args: string[] = [];
  let i = 0;
  while (i < inner.length) {
    // Skip whitespace and commas
    while (i < inner.length && (inner[i] === " " || inner[i] === ",")) i++;
    if (i >= inner.length) break;

    if (inner[i] === '"') {
      // String literal
      i++; // skip opening quote
      let s = "";
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === '\\' && i + 1 < inner.length) {
          const esc = inner[i + 1];
          if (esc === '"') s += '"';
          else if (esc === '\\') s += '\\';
          else if (esc === 'n') s += '\n';
          else if (esc === 'r') s += '\r';
          else s += esc;
          i += 2;
        } else {
          s += inner[i];
          i++;
        }
      }
      i++; // skip closing quote
      args.push(s);
    } else {
      // Non-string token (number, bool, etc.)
      let tok = "";
      while (i < inner.length && inner[i] !== "," && inner[i] !== ")") {
        tok += inner[i++];
      }
      args.push(tok.trim());
    }
  }
  return args;
}

/**
 * Parse ascent-interpreter stdout into raw violations.
 * Output format:
 *   relation_name (N tuples):
 *     (arg1, arg2, ...)
 */
function parseDatalogOutput(stdout: string): RawViolation[] {
  const violations: RawViolation[] = [];
  const lines = stdout.split("\n");
  let currentRule: string | null = null;

  for (const line of lines) {
    // Match relation header: "relation_name (N tuple(s)):"
    const headerMatch = line.match(/^(\w+)\s+\(\d+ tuples?\):$/);
    if (headerMatch) {
      currentRule = headerMatch[1];
      continue;
    }

    if (currentRule) {
      const args = parseTupleLine(line);
      if (args !== null) {
        violations.push({ rule: currentRule, args });
      } else if (line.trim() === "") {
        currentRule = null;
      }
    }
  }

  return violations;
}

// ── Run Datalog ───────────────────────────────────────────────────────────────

const VIOLATION_RELATIONS = new Set([
  "duplicate_entity_id",
  "dangling_entity_ref",
  "dangling_source_ref",
  "domain_violation",
  "range_violation",
  "cardinality_violation_min",
  "cardinality_violation_max",
  "multi_preferred",
  "multi_preferred_instance_of",
  "no_preferred_rank",
  "alias_self_reference",
  "alias_cycle",
  "source_required_violation",
  "cross_lens_fictional",
  "qualifier_unknown_predicate",
  "qualifier_dangling_ref",
  "deprecated_no_end_time",
  "end_without_start",
]);

/** Run the Datalog program with emitted facts, parse violations from stdout. */
export async function runDatalog(
  facts: string,
  rulesPath: string
): Promise<RawViolation[]> {
  const bin = resolveInterpreterBin();

  // Write facts to a temp file, then run: cat facts.dl rules.ascent | interpreter /dev/stdin
  // Actually: write combined program to a temp file
  const fs = await import("fs/promises");
  const os = await import("os");
  const path = await import("path");

  const rulesContent = await fs.readFile(rulesPath, "utf-8");
  const combined = facts + "\n" + rulesContent;

  const tmpFile = path.join(os.tmpdir(), `validate-${Date.now()}.dl`);
  await fs.writeFile(tmpFile, combined, "utf-8");

  try {
    const proc = Bun.spawn([bin, tmpFile], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const _stderr = await new Response(proc.stderr).text();
    await proc.exited;

    const all = parseDatalogOutput(stdout);
    // Filter to only violation relations
    return all.filter(v => VIOLATION_RELATIONS.has(v.rule));
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

// ── Violation enrichment ──────────────────────────────────────────────────────

const RULE_SEVERITY: Record<string, Severity> = {
  duplicate_entity_id: "error",
  dangling_entity_ref: "error",
  dangling_source_ref: "error",
  domain_violation: "error",
  range_violation: "error",
  cardinality_violation_min: "error",
  cardinality_violation_max: "error",
  multi_preferred: "error",
  multi_preferred_instance_of: "error",
  no_preferred_rank: "warning",
  alias_self_reference: "error",
  alias_cycle: "error",
  source_required_violation: "error",
  cross_lens_fictional: "warning",
  qualifier_unknown_predicate: "warning",
  qualifier_dangling_ref: "error",
  deprecated_no_end_time: "warning",
  end_without_start: "warning",
};

/** Build a human-readable violation message from a raw Datalog violation. */
function formatViolationMessage(raw: RawViolation): { entityId: string; predicateId: string; message: string; lens: string } {
  const [a0, a1, a2, a3] = raw.args;
  switch (raw.rule) {
    case "duplicate_entity_id":
      return { entityId: a0, predicateId: "?", lens: a1,
        message: `Entity id '${a0}' also appears in lens '${a2}'. Entity ids must be globally unique.` };
    case "dangling_entity_ref":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `entity ref '@${a2}' does not exist in any loaded lens` };
    case "dangling_source_ref":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `source '${a2}' not found in any lens's sources.jsonl` };
    case "domain_violation":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `entity '${a0}' does not satisfy domain constraint of predicate '${a1}'` };
    case "range_violation":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `target entity does not satisfy range constraint of predicate '${a1}'` };
    case "cardinality_violation_min":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `cardinality min ${a2} not met: found ${a3} real (non-sentinel) values` };
    case "cardinality_violation_max":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `cardinality max ${a2} exceeded: found ${a3} total values` };
    case "multi_preferred":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `predicate '${a1}' has multiple merged statements with rank: "preferred" — at most one may be preferred` };
    case "multi_preferred_instance_of":
      return { entityId: a0, predicateId: "instance_of", lens: "?",
        message: `entity has multiple instance_of statements with rank: "preferred" — at most one may be preferred` };
    case "no_preferred_rank":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `predicate '${a1}' has 2+ active statements but none has rank: "preferred"` };
    case "alias_self_reference":
      return { entityId: "?", predicateId: a0, lens: "?",
        message: `predicate '${a0}' has alias_of pointing to itself` };
    case "alias_cycle":
      return { entityId: "?", predicateId: a0, lens: "?",
        message: `predicate '${a0}' alias_of forms a cycle` };
    case "source_required_violation":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `lens requires sources, but statement has no source` };
    case "cross_lens_fictional":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `factual lens references entity owned by fictional/interpretive lens '${a2}'` };
    case "qualifier_unknown_predicate":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `qualifier key '${a2}' is not a defined predicate` };
    case "qualifier_dangling_ref":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `dangling entity ref '@${a2}' in qualifier` };
    case "deprecated_no_end_time":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `deprecated statement on predicate '${a1}' has no end_time qualifier` };
    case "end_without_start":
      return { entityId: a0, predicateId: a1, lens: "?",
        message: `statement on predicate '${a1}' has end_time qualifier but no start_time` };
    default:
      return { entityId: a0 ?? "?", predicateId: a1 ?? "?", lens: "?", message: raw.args.join(", ") };
  }
}

// Predicate-keyed rules: look up provenance from predicateProv
const PREDICATE_KEYED_RULES = new Set([
  "alias_self_reference",
  "alias_cycle",
  "predicate_lens_mismatch",
]);

// Lens-keyed rules
const LENS_KEYED_RULES = new Set([
  "lens_dep_cycle",
]);

/** Attach file:line provenance to raw Datalog violations. */
export function enrichViolations(
  rawViolations: RawViolation[],
  lensSet: LoadedLensSet,
  provenance: ProvenanceMaps
): Violation[] {
  const violations: Violation[] = [];

  for (const raw of rawViolations) {
    const severity = RULE_SEVERITY[raw.rule] ?? "error";
    const { entityId, predicateId, message, lens: lensHint } = formatViolationMessage(raw);

    let file: string;
    let line: number;
    let lens: string;

    if (PREDICATE_KEYED_RULES.has(raw.rule)) {
      // Use predicate provenance
      const predProv = provenance.predicate.get(predicateId !== "?" ? predicateId : raw.args[0] ?? "");
      file = predProv?.file ?? "(datalog)";
      line = predProv?.line ?? 0;
      lens = predProv?.lensId ?? lensHint;
    } else if (LENS_KEYED_RULES.has(raw.rule)) {
      // Use lens provenance
      const lensProv = provenance.lens.get(lensHint);
      file = lensProv?.manifestPath ?? "(datalog)";
      line = 0;
      lens = lensHint;
    } else {
      // Statement-keyed: look up entity provenance from stmt map
      const entityProv = provenance.stmt.get(`entity#${entityId}`);
      file = entityProv?.file ?? "(datalog)";
      line = entityProv?.line ?? 0;
      lens = entityProv?.lensId ?? lensHint;
    }

    violations.push({ severity, lens, file, line, entityId, predicateId, rule: raw.rule, message });
  }

  return violations;
}
