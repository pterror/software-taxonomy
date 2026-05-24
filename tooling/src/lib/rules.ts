// Validation rules ported from validate.ascent to @thi.ng/rstream-query.
//
// Strategy:
//  - Use q() for basic joins; post-process in TS for recursion/negation/aggregation.
//  - In data/, entity ids and statement values keep the "@ns:slug" prefix throughout.
//  - Recursion (transitive closures) computed via iterative fixpoint — rstream-query
//    has no recursion.
//  - Negation-as-failure: build positive set, then filter in TS.
//  - Aggregation: groupBy in TS after fetching all rows.

import { q, type Db } from "./store.js";
import type { Violation } from "./violations.js";

// ─── Closure helpers ──────────────────────────────────────────────────────────

/** Build transitive closure of subclass_of.
 * Returns Map<childId, Set<ancestorId>> where ids are "@ns:slug" strings. */
function buildSubclassClosure(stmts: StmtRow[]): Map<string, Set<string>> {
  const directEdges = new Map<string, Set<string>>(); // child → set of parents

  for (const stmt of stmts) {
    if (!stmt.predicate.endsWith(":subclass_of")) continue;
    if (!stmt.value.startsWith("@")) continue;
    const parent = stmt.value; // "@ns:slug"
    const child = stmt.subject;
    if (!directEdges.has(child)) directEdges.set(child, new Set());
    directEdges.get(child)!.add(parent);
  }

  // Iterative fixpoint expansion
  const closure = new Map<string, Set<string>>();
  for (const [child, parents] of directEdges) {
    if (!closure.has(child)) closure.set(child, new Set());
    for (const p of parents) closure.get(child)!.add(p);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, ancestors] of closure) {
      for (const anc of [...ancestors]) {
        const grandparents = closure.get(anc);
        if (grandparents) {
          for (const gp of grandparents) {
            if (!ancestors.has(gp)) {
              ancestors.add(gp);
              changed = true;
            }
          }
        }
      }
    }
  }
  return closure;
}

/** Build transitive instance_of closure.
 * Returns Map<entityId, Set<classId>> where ids are "@ns:slug" strings.
 * Expands via subclassClosure so instance_of cls also grants all superclasses. */
function buildInstanceClosure(stmts: StmtRow[], subclassClosure: Map<string, Set<string>>): Map<string, Set<string>> {
  const directInst = new Map<string, Set<string>>(); // entity → direct classes

  for (const stmt of stmts) {
    if (!stmt.predicate.endsWith(":instance_of")) continue;
    if (!stmt.value.startsWith("@")) continue;
    const cls = stmt.value;
    if (!directInst.has(stmt.subject)) directInst.set(stmt.subject, new Set());
    directInst.get(stmt.subject)!.add(cls);
  }

  const closure = new Map<string, Set<string>>();
  for (const [entity, directClasses] of directInst) {
    const allClasses = new Set<string>(directClasses);
    for (const cls of directClasses) {
      const supers = subclassClosure.get(cls);
      if (supers) for (const s of supers) allClasses.add(s);
    }
    closure.set(entity, allClasses);
  }
  return closure;
}

/** Build alias_reachable closure: pred → set of reachable preds via alias_of. */
function buildAliasClosure(directAlias: Map<string, string>): Map<string, Set<string>> {
  const closure = new Map<string, Set<string>>();
  for (const [pred, target] of directAlias) {
    if (!closure.has(pred)) closure.set(pred, new Set());
    closure.get(pred)!.add(target);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [pred, reachable] of closure) {
      for (const r of [...reachable]) {
        const next = directAlias.get(r);
        if (next && !reachable.has(next)) {
          reachable.add(next);
          changed = true;
        }
      }
    }
  }
  return closure;
}

/** Resolve predicate id to canonical (non-aliased) id. */
function resolveCanonical(pred: string, directAlias: Map<string, string>): string {
  const seen = new Set<string>();
  let cur = pred;
  while (directAlias.has(cur)) {
    if (seen.has(cur)) return cur; // cycle guard
    seen.add(cur);
    cur = directAlias.get(cur)!;
  }
  return cur;
}

// ─── Core data types ─────────────────────────────────────────────────────────

interface PredDef {
  id: string;
  valuetype: string;
  cardmin: number;
  cardmax: number; // -1 = unbounded
  expectpreferred: boolean;
  lens: string;
  domain: string[]; // "@ns:slug" entity ids
  range: string[];  // "@ns:slug" entity ids
  aliasOf: string | null;
}

interface StmtRow {
  id: string;
  subject: string;    // "@ns:slug"
  predicate: string;  // "@ns:slug"
  value: string;
  rank: string;
  lens: string;
  qualifiers: Record<string, string> | null;
}

interface LensRow {
  id: string;
  register: string;
  sourceRequired: boolean;
}

// ─── Bulk data loaders ────────────────────────────────────────────────────────

function loadPredicateDefs(db: Db): Map<string, PredDef> {
  const baseRows = q(
    { q: [{ where: [
      ["?e", "predicate/id", "?id"],
      ["?e", "predicate/value_type", "?vt"],
      ["?e", "predicate/cardinality", "?card"],
      ["?e", "predicate/lens", "?lens"],
    ]}], select: ["id", "vt", "card", "lens"] },
    db,
  );

  // Build subject → attribute map for optional fields by querying all relevant triples.
  const epMap = new Map<string, boolean>();
  for (const row of q({ q: [{ where: [["?e", "predicate/id", "?id"], ["?e", "predicate/expect_preferred", "?ep"]] }], select: ["id", "ep"] }, db)) {
    epMap.set(row["id"] as string, Boolean(row["ep"]));
  }
  const domMap = new Map<string, string>();
  for (const row of q({ q: [{ where: [["?e", "predicate/id", "?id"], ["?e", "predicate/domain", "?d"]] }], select: ["id", "d"] }, db)) {
    domMap.set(row["id"] as string, row["d"] as string);
  }
  const rngMap = new Map<string, string>();
  for (const row of q({ q: [{ where: [["?e", "predicate/id", "?id"], ["?e", "predicate/range", "?r"]] }], select: ["id", "r"] }, db)) {
    rngMap.set(row["id"] as string, row["r"] as string);
  }
  const aliasMap = new Map<string, string>();
  for (const row of q({ q: [{ where: [["?e", "predicate/id", "?id"], ["?e", "predicate/alias_of", "?ao"]] }], select: ["id", "ao"] }, db)) {
    aliasMap.set(row["id"] as string, row["ao"] as string);
  }

  const defs = new Map<string, PredDef>();
  for (const row of baseRows) {
    const id = row["id"] as string;
    const vt = row["vt"] as string;
    const card = row["card"] as string;
    const lens = row["lens"] as string;

    const [minPart, maxPart] = card.split("..");
    const cardmin = parseInt(minPart, 10) || 0;
    const cardmax = maxPart === "*" ? -1 : parseInt(maxPart, 10) || 0;

    const domJson = domMap.get(id);
    const domain: string[] = domJson ? (JSON.parse(domJson) as string[] | null ?? []) : [];

    const rngJson = rngMap.get(id);
    const range: string[] = rngJson ? (JSON.parse(rngJson) as string[] | null ?? []) : [];

    // expect_preferred defaults to true when absent — matches old datalog.ts behaviour
    // (old code: `pred.expect_preferred !== false`, so undefined → true)
    const ep = epMap.get(id);
    const expectpreferred = ep !== undefined ? ep : true;

    defs.set(id, {
      id,
      valuetype: vt,
      cardmin,
      cardmax,
      expectpreferred,
      lens,
      domain,
      range,
      aliasOf: aliasMap.get(id) ?? null,
    });
  }
  return defs;
}

function loadAllStatements(db: Db): StmtRow[] {
  const baseRows = q(
    { q: [{ where: [
      ["?s", "statement/id", "?id"],
      ["?s", "statement/subject", "?subj"],
      ["?s", "statement/predicate", "?pred"],
      ["?s", "statement/value", "?val"],
      ["?s", "statement/lens", "?lens"],
    ]}], select: ["id", "subj", "pred", "val", "lens"] },
    db,
  );

  const rankMap = new Map<string, string>();
  for (const row of q({ q: [{ where: [["?s", "statement/id", "?id"], ["?s", "statement/rank", "?r"]] }], select: ["id", "r"] }, db)) {
    rankMap.set(row["id"] as string, row["r"] as string);
  }
  const qualMap = new Map<string, Record<string, string>>();
  for (const row of q({ q: [{ where: [["?s", "statement/id", "?id"], ["?s", "statement/qualifiers", "?q"]] }], select: ["id", "q"] }, db)) {
    const parsed = JSON.parse(row["q"] as string);
    if (parsed && typeof parsed === "object") qualMap.set(row["id"] as string, parsed as Record<string, string>);
  }

  const stmts: StmtRow[] = [];
  for (const row of baseRows) {
    const id = row["id"] as string;
    stmts.push({
      id,
      subject: row["subj"] as string,
      predicate: row["pred"] as string,
      value: row["val"] as string,
      rank: rankMap.get(id) ?? "normal",
      lens: row["lens"] as string,
      qualifiers: qualMap.get(id) ?? null,
    });
  }
  return stmts;
}

function loadAllLenses(db: Db): Map<string, LensRow> {
  const rows = q(
    { q: [{ where: [
      ["?e", "lens/id", "?id"],
      ["?e", "lens/register", "?reg"],
      ["?e", "lens/source_required", "?sr"],
    ]}], select: ["id", "reg", "sr"] },
    db,
  );
  const lenses = new Map<string, LensRow>();
  for (const row of rows) {
    lenses.set(row["id"] as string, {
      id: row["id"] as string,
      register: row["reg"] as string,
      sourceRequired: Boolean(row["sr"]),
    });
  }
  return lenses;
}

function loadEntityIds(db: Db): Set<string> {
  const rows = q({ q: [{ where: [["?e", "entity/id", "?id"]] }], select: ["id"] }, db);
  const ids = new Set<string>();
  for (const row of rows) ids.add(row["id"] as string);
  return ids;
}

function loadSourceIds(db: Db): Set<string> {
  const rows = q({ q: [{ where: [["?e", "source/id", "?id"]] }], select: ["id"] }, db);
  const ids = new Set<string>();
  for (const row of rows) ids.add(row["id"] as string);
  return ids;
}

/** Get file/line for a statement id (cached via Maps in context). */
function buildProvenanceMaps(db: Db): { fileMap: Map<string, string>; lineMap: Map<string, number> } {
  const fileMap = new Map<string, string>();
  const lineMap = new Map<string, number>();
  for (const row of q({ q: [{ where: [["?s", "statement/id", "?id"], ["?s", "statement/file", "?f"]] }], select: ["id", "f"] }, db)) {
    fileMap.set(row["id"] as string, row["f"] as string);
  }
  for (const row of q({ q: [{ where: [["?s", "statement/id", "?id"], ["?s", "statement/line", "?l"]] }], select: ["id", "l"] }, db)) {
    lineMap.set(row["id"] as string, row["l"] as number);
  }
  return { fileMap, lineMap };
}

/** Extract local name from predicate id: "@core:foo" → "foo" */
function localName(predId: string): string {
  const colon = predId.lastIndexOf(":");
  return colon >= 0 ? predId.slice(colon + 1) : predId;
}

// ─── Context bundle ───────────────────────────────────────────────────────────

interface ValidateContext {
  db: Db;
  entityIds: Set<string>;      // "@ns:slug"
  sourceIds: Set<string>;
  stmts: StmtRow[];
  predDefs: Map<string, PredDef>;
  directAlias: Map<string, string>;
  aliasClosure: Map<string, Set<string>>;
  subclassClosure: Map<string, Set<string>>;
  instanceClosure: Map<string, Set<string>>;
  lenses: Map<string, LensRow>;
  entityOwner: Map<string, string>;  // entity "@ns:slug" → lens id
  fileMap: Map<string, string>;
  lineMap: Map<string, number>;
  sourcedStmtIds: Set<string>;
}

export function buildContext(db: Db): ValidateContext {
  const entityIds = loadEntityIds(db);
  const sourceIds = loadSourceIds(db);
  const stmts = loadAllStatements(db);
  const predDefs = loadPredicateDefs(db);
  const lenses = loadAllLenses(db);

  const directAlias = new Map<string, string>();
  for (const [id, def] of predDefs) {
    if (def.aliasOf) directAlias.set(id, def.aliasOf);
  }

  const aliasClosure = buildAliasClosure(directAlias);
  const subclassClosure = buildSubclassClosure(stmts);
  const instanceClosure = buildInstanceClosure(stmts, subclassClosure);

  // entity owner: read from entity/lens attribute (stored by load.ts).
  // Falls back to the first statement's lens for entities without an explicit lens attribute.
  const entityOwner = new Map<string, string>();
  for (const row of q({ q: [{ where: [["?e", "entity/id", "?id"], ["?e", "entity/lens", "?lens"]] }], select: ["id", "lens"] }, db)) {
    entityOwner.set(row["id"] as string, row["lens"] as string);
  }
  // Fallback for entities without entity/lens (old data/ files before this field was added)
  for (const stmt of stmts) {
    if (!entityOwner.has(stmt.subject)) {
      entityOwner.set(stmt.subject, stmt.lens);
    }
  }

  const { fileMap, lineMap } = buildProvenanceMaps(db);

  // Build sourced statement id set
  const sourcedStmtIds = new Set<string>();
  for (const row of q({ q: [{ where: [["?sl", "src-link/statement", "?sid"]] }], select: ["sid"] }, db)) {
    sourcedStmtIds.add(row["sid"] as string);
  }

  return { db, entityIds, sourceIds, stmts, predDefs, directAlias, aliasClosure, subclassClosure, instanceClosure, lenses, entityOwner, fileMap, lineMap, sourcedStmtIds };
}

// ─── Effective predicate helpers ──────────────────────────────────────────────

function effectiveDef(predId: string, ctx: ValidateContext): PredDef | undefined {
  const canon = resolveCanonical(predId, ctx.directAlias);
  return ctx.predDefs.get(canon);
}

function effectiveDomain(predId: string, ctx: ValidateContext): string[] {
  return effectiveDef(predId, ctx)?.domain ?? [];
}

function effectiveRange(predId: string, ctx: ValidateContext): string[] {
  return effectiveDef(predId, ctx)?.range ?? [];
}

// ─── Class membership helpers ─────────────────────────────────────────────────

/** Is entity a class (transitively instance_of "@meta:class")? */
function isClass(entityId: string, ctx: ValidateContext): boolean {
  if (entityId === "@meta:class") return true;
  return ctx.instanceClosure.get(entityId)?.has("@meta:class") ?? false;
}

/** Does entity satisfy a domain/range class constraint? */
function satisfiesClass(entityId: string, classId: string, ctx: ValidateContext): boolean {
  return ctx.instanceClosure.get(entityId)?.has(classId) ?? false;
}

// ─── Provenance helpers ───────────────────────────────────────────────────────

function prov(stmtId: string, ctx: ValidateContext): { file?: string; line?: number } {
  return { file: ctx.fileMap.get(stmtId), line: ctx.lineMap.get(stmtId) };
}

// ─── Rule implementations ─────────────────────────────────────────────────────

/**
 * duplicate_entity_id: fires for same entity id in two lenses or twice in one lens.
 * In data/ entities are merged by convert.ts — cross-lens duplicates don't exist.
 * This rule has no violations in data/ by construction.
 */
export function duplicateEntityId(_ctx: ValidateContext): Violation[] {
  return [];
}

/**
 * dangling_entity_ref: statement references a non-existent entity.
 */
export function danglingEntityRef(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const stmt of ctx.stmts) {
    if (!stmt.value.startsWith("@")) continue;
    const targetId = stmt.value; // "@ns:slug" — already @-prefixed
    if (ctx.entityIds.has(targetId)) continue;
    const key = `${stmt.subject}|${stmt.predicate}|${targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { file, line } = prov(stmt.id, ctx);
    violations.push({
      rule: "dangling_entity_ref",
      severity: "error",
      subject: stmt.subject,
      predicate: stmt.predicate,
      value: targetId,
      message: `entity ref '${targetId}' does not exist in any loaded lens`,
      file, line, lens: stmt.lens,
    });
  }
  return violations;
}

/**
 * dangling_source_ref: statement's source id not found in any source record.
 */
export function danglingSourceRef(ctx: ValidateContext): Violation[] {
  const rows = q(
    { q: [{ where: [["?sl", "src-link/statement", "?stmtId"], ["?sl", "src-link/source", "?srcId"]] }],
      select: ["stmtId", "srcId"] },
    ctx.db,
  );

  const stmtMap = new Map<string, StmtRow>();
  for (const s of ctx.stmts) stmtMap.set(s.id, s);

  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const stmtId = row["stmtId"] as string;
    const srcId = row["srcId"] as string;
    if (ctx.sourceIds.has(srcId)) continue;
    const stmt = stmtMap.get(stmtId);
    if (!stmt) continue;
    const key = `${stmt.subject}|${stmt.predicate}|${srcId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { file, line } = prov(stmtId, ctx);
    violations.push({
      rule: "dangling_source_ref",
      severity: "error",
      subject: stmt.subject,
      predicate: stmt.predicate,
      value: srcId,
      message: `source '${srcId}' not found in any lens's sources`,
      file, line, lens: stmt.lens,
    });
  }
  return violations;
}

/**
 * domain_violation: entity uses predicate without satisfying any domain class.
 * Exception: instance_of/subclass_of on class entities are structural (exempt).
 */
export function domainViolation(ctx: ValidateContext): Violation[] {
  // Collect (entity, predicate) pairs with at least one active stmt
  const activePairs = new Map<string, StmtRow>(); // key → rep stmt
  for (const stmt of ctx.stmts) {
    if (stmt.rank === "deprecated") continue;
    const key = `${stmt.subject}|${stmt.predicate}`;
    if (!activePairs.has(key)) activePairs.set(key, stmt);
  }

  const violations: Violation[] = [];
  for (const [key, rep] of activePairs) {
    const [entity, pred] = key.split("|");
    const domain = effectiveDomain(pred, ctx);
    if (domain.length === 0) continue;

    const localPred = localName(pred);
    if (isClass(entity, ctx) && (localPred === "instance_of" || localPred === "subclass_of")) continue;

    const ok = domain.some(d => satisfiesClass(entity, d, ctx));
    if (!ok) {
      const { file, line } = prov(rep.id, ctx);
      violations.push({
        rule: "domain_violation",
        severity: "error",
        subject: entity,
        predicate: pred,
        message: `entity '${entity}' does not satisfy domain constraint of predicate '${pred}'`,
        file, line, lens: rep.lens,
      });
    }
  }
  return violations;
}

/**
 * range_violation: entity ref target doesn't satisfy range class.
 * Deprecated stmts exempt. Dangling refs handled by dangling_entity_ref.
 */
export function rangeViolation(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();

  for (const stmt of ctx.stmts) {
    if (stmt.rank === "deprecated") continue;
    if (!stmt.value.startsWith("@")) continue;
    const targetId = stmt.value;
    if (!ctx.entityIds.has(targetId)) continue; // dangling — skip

    const range = effectiveRange(stmt.predicate, ctx);
    if (range.length === 0) continue;

    const ok = range.some(r => satisfiesClass(targetId, r, ctx));
    if (!ok) {
      const key = `${stmt.subject}|${stmt.predicate}|${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { file, line } = prov(stmt.id, ctx);
      violations.push({
        rule: "range_violation",
        severity: "error",
        subject: stmt.subject,
        predicate: stmt.predicate,
        value: targetId,
        message: `entity '${targetId}' does not satisfy range constraint of predicate '${stmt.predicate}'`,
        file, line, lens: stmt.lens,
      });
    }
  }
  return violations;
}

/**
 * multi_preferred: 2+ active stmts with rank=preferred for (entity, predicate).
 * instance_of handled separately by multi_preferred_instance_of.
 */
export function multiPreferred(ctx: ValidateContext): Violation[] {
  const counts = new Map<string, { count: number; rep: StmtRow }>();
  for (const stmt of ctx.stmts) {
    if (stmt.rank !== "preferred") continue;
    const key = `${stmt.subject}|${stmt.predicate}`;
    const entry = counts.get(key);
    if (!entry) counts.set(key, { count: 1, rep: stmt });
    else entry.count++;
  }

  const violations: Violation[] = [];
  for (const [key, { count, rep }] of counts) {
    if (count <= 1) continue;
    const [entity, pred] = key.split("|");
    if (localName(pred) === "instance_of") continue;
    const { file, line } = prov(rep.id, ctx);
    violations.push({
      rule: "multi_preferred",
      severity: "error",
      subject: entity,
      predicate: pred,
      message: `predicate '${pred}' has multiple merged statements with rank: "preferred"`,
      file, line, lens: rep.lens,
    });
  }
  return violations;
}

/**
 * multi_preferred_instance_of: 2+ instance_of stmts with rank=preferred.
 */
export function multiPreferredInstanceOf(ctx: ValidateContext): Violation[] {
  const counts = new Map<string, { count: number; rep: StmtRow }>();
  for (const stmt of ctx.stmts) {
    if (stmt.rank !== "preferred") continue;
    if (!stmt.predicate.endsWith(":instance_of")) continue;
    const entry = counts.get(stmt.subject);
    if (!entry) counts.set(stmt.subject, { count: 1, rep: stmt });
    else entry.count++;
  }

  const violations: Violation[] = [];
  for (const [entity, { count, rep }] of counts) {
    if (count <= 1) continue;
    const { file, line } = prov(rep.id, ctx);
    violations.push({
      rule: "multi_preferred_instance_of",
      severity: "error",
      subject: entity,
      predicate: "instance_of",
      message: `entity has multiple instance_of statements with rank: "preferred"`,
      file, line, lens: rep.lens,
    });
  }
  return violations;
}

/**
 * no_preferred_rank: 2+ active stmts, none preferred, predicate has expect_preferred:true.
 * Special case: instance_of with 2+ active stmts, none preferred (no expect_preferred check).
 */
export function noPreferredRank(ctx: ValidateContext): Violation[] {
  // Group active (non-deprecated) stmts by (subject, predicate)
  const groups = new Map<string, { all: StmtRow[]; preferred: number }>();
  for (const stmt of ctx.stmts) {
    if (stmt.rank === "deprecated") continue;
    const key = `${stmt.subject}|${stmt.predicate}`;
    const entry = groups.get(key);
    if (!entry) groups.set(key, { all: [stmt], preferred: stmt.rank === "preferred" ? 1 : 0 });
    else { entry.all.push(stmt); if (stmt.rank === "preferred") entry.preferred++; }
  }

  const violations: Violation[] = [];
  for (const [key, { all, preferred }] of groups) {
    if (all.length < 2 || preferred > 0) continue;
    const [entity, pred] = key.split("|");
    const isInstanceOf = pred.endsWith(":instance_of");
    if (!isInstanceOf) {
      const def = effectiveDef(pred, ctx);
      if (!def?.expectpreferred) continue;
    }
    const rep = all[0];
    const { file, line } = prov(rep.id, ctx);
    violations.push({
      rule: "no_preferred_rank",
      severity: "warning",
      subject: entity,
      predicate: pred,
      message: `predicate '${pred}' has 2+ active statements but none has rank: "preferred"`,
      file, line, lens: rep.lens,
    });
  }
  return violations;
}

/**
 * cardinality_violation_min: real (non-sentinel "__sentinel__") count < min.
 * cardinality_violation_max: total active count > max.
 */
function cardinalityViolations(ctx: ValidateContext, mode: "min" | "max"): Violation[] {
  const groups = new Map<string, { real: number; total: number; rep: StmtRow }>();

  for (const stmt of ctx.stmts) {
    if (stmt.rank === "deprecated") continue;
    const key = `${stmt.subject}|${stmt.predicate}`;
    const isSentinel = stmt.value === "__sentinel__";
    const entry = groups.get(key);
    if (!entry) groups.set(key, { real: isSentinel ? 0 : 1, total: 1, rep: stmt });
    else { if (!isSentinel) entry.real++; entry.total++; }
  }

  const violations: Violation[] = [];
  for (const [key, { real, total, rep }] of groups) {
    const [entity, pred] = key.split("|");
    const def = effectiveDef(pred, ctx);
    if (!def) continue;

    if (mode === "min" && def.cardmin > 0 && real < def.cardmin) {
      const { file, line } = prov(rep.id, ctx);
      violations.push({
        rule: "cardinality_violation_min",
        severity: "error",
        subject: entity,
        predicate: pred,
        message: `cardinality min ${def.cardmin} not met: found ${real} real (non-sentinel) values`,
        file, line, lens: rep.lens,
      });
    }
    if (mode === "max" && def.cardmax >= 0 && total > def.cardmax) {
      const { file, line } = prov(rep.id, ctx);
      violations.push({
        rule: "cardinality_violation_max",
        severity: "error",
        subject: entity,
        predicate: pred,
        message: `cardinality max ${def.cardmax} exceeded: found ${total} total values`,
        file, line, lens: rep.lens,
      });
    }
  }
  return violations;
}

export function cardinalityViolationMin(ctx: ValidateContext): Violation[] {
  return cardinalityViolations(ctx, "min");
}
export function cardinalityViolationMax(ctx: ValidateContext): Violation[] {
  return cardinalityViolations(ctx, "max");
}

/**
 * deprecated_no_end_time: deprecated statement without end_time qualifier.
 */
export function deprecatedNoEndTime(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const stmt of ctx.stmts) {
    if (stmt.rank !== "deprecated") continue;
    const hasEndTime = stmt.qualifiers &&
      Object.keys(stmt.qualifiers).some(k => localName(k) === "end_time");
    if (!hasEndTime) {
      const key = `${stmt.subject}|${stmt.predicate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { file, line } = prov(stmt.id, ctx);
      violations.push({
        rule: "deprecated_no_end_time",
        severity: "warning",
        subject: stmt.subject,
        predicate: stmt.predicate,
        message: `deprecated statement on predicate '${stmt.predicate}' has no end_time qualifier`,
        file, line, lens: stmt.lens,
      });
    }
  }
  return violations;
}

/**
 * end_without_start: non-deprecated non-sentinel stmt has end_time but no start_time.
 */
export function endWithoutStart(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const stmt of ctx.stmts) {
    if (stmt.rank === "deprecated") continue;
    if (stmt.value === "__sentinel__") continue;
    if (!stmt.qualifiers) continue;
    const keys = Object.keys(stmt.qualifiers).map(k => localName(k));
    if (!keys.includes("end_time")) continue;
    if (keys.includes("start_time")) continue;
    const key = `${stmt.subject}|${stmt.predicate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { file, line } = prov(stmt.id, ctx);
    violations.push({
      rule: "end_without_start",
      severity: "warning",
      subject: stmt.subject,
      predicate: stmt.predicate,
      message: `statement on predicate '${stmt.predicate}' has end_time qualifier but no start_time`,
      file, line, lens: stmt.lens,
    });
  }
  return violations;
}

/**
 * source_required_violation: lens requires sources, but a non-deprecated non-sentinel
 * statement (per stmt_id) has no source. Structural exemption for class entities.
 */
export function sourceRequiredViolation(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  for (const stmt of ctx.stmts) {
    if (stmt.rank === "deprecated") continue;
    if (stmt.value === "__sentinel__") continue;
    const lensRecord = ctx.lenses.get(stmt.lens);
    if (!lensRecord?.sourceRequired) continue;

    const localPred = localName(stmt.predicate);
    if (isClass(stmt.subject, ctx) && (localPred === "instance_of" || localPred === "subclass_of")) continue;

    if (!ctx.sourcedStmtIds.has(stmt.id)) {
      const { file, line } = prov(stmt.id, ctx);
      violations.push({
        rule: "source_required_violation",
        severity: "error",
        subject: stmt.subject,
        predicate: stmt.predicate,
        message: `lens requires sources, but statement has no source`,
        file, line, lens: stmt.lens,
      });
    }
  }
  return violations;
}

/**
 * cross_lens_fictional: factual lens entity references an entity owned by
 * a fictional or interpretive lens.
 */
export function crossLensFictional(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();

  for (const stmt of ctx.stmts) {
    if (stmt.rank === "deprecated") continue;
    if (!stmt.value.startsWith("@")) continue;
    const subjectLens = ctx.lenses.get(stmt.lens);
    if (subjectLens?.register !== "factual") continue;

    const targetId = stmt.value;
    if (!ctx.entityIds.has(targetId)) continue; // dangling

    const targetLensId = ctx.entityOwner.get(targetId);
    if (!targetLensId) continue;
    const targetLens = ctx.lenses.get(targetLensId);
    if (!targetLens) continue;
    if (targetLens.register !== "fictional" && targetLens.register !== "interpretive") continue;

    const key = `${stmt.subject}|${stmt.predicate}|${targetLensId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { file, line } = prov(stmt.id, ctx);
    violations.push({
      rule: "cross_lens_fictional",
      severity: "warning",
      subject: stmt.subject,
      predicate: stmt.predicate,
      value: targetLensId,
      message: `factual lens references entity '${stmt.subject}' owned by fictional/interpretive lens '${targetLensId}'`,
      file, line, lens: stmt.lens,
    });
  }
  return violations;
}

/**
 * qualifier_unknown_predicate: qualifier key is not a defined predicate.
 */
export function qualifierUnknownPredicate(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const stmt of ctx.stmts) {
    if (!stmt.qualifiers) continue;
    for (const qPred of Object.keys(stmt.qualifiers)) {
      if (ctx.predDefs.has(qPred)) continue;
      const key = `${stmt.subject}|${stmt.predicate}|${qPred}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { file, line } = prov(stmt.id, ctx);
      violations.push({
        rule: "qualifier_unknown_predicate",
        severity: "warning",
        subject: stmt.subject,
        predicate: stmt.predicate,
        value: qPred,
        message: `qualifier key '${qPred}' is not a defined predicate`,
        file, line, lens: stmt.lens,
      });
    }
  }
  return violations;
}

/**
 * qualifier_dangling_ref: entity-ref qualifier points to non-existent entity.
 */
export function qualifierDanglingRef(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const stmt of ctx.stmts) {
    if (!stmt.qualifiers) continue;
    for (const qVal of Object.values(stmt.qualifiers)) {
      if (typeof qVal !== "string" || !qVal.startsWith("@")) continue;
      const targetId = qVal; // already "@ns:slug"
      if (ctx.entityIds.has(targetId)) continue;
      const key = `${stmt.subject}|${stmt.predicate}|${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { file, line } = prov(stmt.id, ctx);
      violations.push({
        rule: "qualifier_dangling_ref",
        severity: "error",
        subject: stmt.subject,
        predicate: stmt.predicate,
        value: targetId,
        message: `dangling entity ref '${targetId}' in qualifier of predicate '${stmt.predicate}'`,
        file, line, lens: stmt.lens,
      });
    }
  }
  return violations;
}

/**
 * alias_self_reference: predicate's alias_of points to itself.
 */
export function aliasSelfReference(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  for (const [pred, target] of ctx.directAlias) {
    if (pred === target) {
      const def = ctx.predDefs.get(pred);
      violations.push({
        rule: "alias_self_reference",
        severity: "error",
        subject: pred,
        predicate: pred,
        message: `predicate '${pred}' has alias_of pointing to itself`,
        lens: def?.lens,
      });
    }
  }
  return violations;
}

/**
 * alias_cycle: alias_of chain forms a cycle (pred can reach itself).
 */
export function aliasCycle(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  for (const [pred, reachable] of ctx.aliasClosure) {
    if (reachable.has(pred)) {
      const def = ctx.predDefs.get(pred);
      violations.push({
        rule: "alias_cycle",
        severity: "error",
        subject: pred,
        predicate: pred,
        message: `predicate '${pred}' alias_of forms a cycle`,
        lens: def?.lens,
      });
    }
  }
  return violations;
}

/**
 * predicate_lens_mismatch: predicate record's "lens" field disagrees with
 * the lens namespace in its id. In data/, predicate id = "@<lensId>:slug"
 * and predicate/lens = lensId. A mismatch is when these differ.
 */
export function predicateLensMismatch(ctx: ValidateContext): Violation[] {
  const violations: Violation[] = [];
  for (const [predId, def] of ctx.predDefs) {
    if (!predId.startsWith("@")) continue;
    const bare = predId.slice(1);
    const colon = bare.indexOf(":");
    if (colon < 0) continue;
    const lensFromId = bare.slice(0, colon);
    if (lensFromId !== def.lens) {
      violations.push({
        rule: "predicate_lens_mismatch",
        severity: "error",
        subject: predId,
        predicate: predId,
        message: `predicate.lens is '${def.lens}' but file is in lens '${lensFromId}'`,
        lens: lensFromId,
      });
    }
  }
  return violations;
}

/**
 * dangling_extension and own_entity_extension: not applicable in data/ —
 * extensions are merged into entity files by convert.ts.
 */
export function danglingExtension(_ctx: ValidateContext): Violation[] { return []; }
export function ownEntityExtension(_ctx: ValidateContext): Violation[] { return []; }

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export function runAllRules(db: Db): Violation[] {
  const ctx = buildContext(db);
  return [
    ...duplicateEntityId(ctx),
    ...danglingEntityRef(ctx),
    ...danglingSourceRef(ctx),
    ...domainViolation(ctx),
    ...rangeViolation(ctx),
    ...multiPreferred(ctx),
    ...multiPreferredInstanceOf(ctx),
    ...noPreferredRank(ctx),
    ...cardinalityViolationMin(ctx),
    ...cardinalityViolationMax(ctx),
    ...deprecatedNoEndTime(ctx),
    ...endWithoutStart(ctx),
    ...sourceRequiredViolation(ctx),
    ...crossLensFictional(ctx),
    ...qualifierUnknownPredicate(ctx),
    ...qualifierDanglingRef(ctx),
    ...aliasSelfReference(ctx),
    ...aliasCycle(ctx),
    ...predicateLensMismatch(ctx),
    ...danglingExtension(ctx),
    ...ownEntityExtension(ctx),
  ];
}
