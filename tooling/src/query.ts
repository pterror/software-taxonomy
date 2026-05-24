// query.ts — CLI for querying the data store.
//
// Supported flags:
//   --entity <@id>           print a single entity as JSON or text
//   --instance-of <@id>      list entities that are (transitively) instances of a class
//   --subclass-of <@id>      list entities that are (transitively) subclasses of a class
//   --has-predicate <id>     list entities that have at least one statement for a predicate
//   --transitive             expand instance_of / subclass_of transitively (default: false)
//   --format text|json       output format (default: json)
//   --lens <l1,l2,...>       restrict results to these lens ids
//   --lens-family <family>   restrict to lenses with matching family field
//
// Gaps vs query.ts:
//   - No --lens-family standalone listing (old tool listed entities from matching-family lenses).
//     Supported when combined with other filters by translating to --lens filter set.
//   - entity labels are stored as JSON-stringified Record<string,string>; parsed on output.

import { loadData } from "./lib/load.js";
import { q } from "./lib/store.js";

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const entityArg      = getArg("--entity");
const instanceOfArg  = getArg("--instance-of");
const subclassOfArg  = getArg("--subclass-of");
const hasPredicateArg= getArg("--has-predicate");
const transitive     = hasFlag("--transitive");
const format         = getArg("--format") ?? "json";
const lensArg        = getArg("--lens");
const lensFamilyArg  = getArg("--lens-family");

function stripAt(id: string): string {
  return id.startsWith("@") ? id : `@${id}`;
}

const db = loadData();

// Resolve --lens-family → set of lens ids
let lensFilter: Set<string> | undefined;
if (lensArg) {
  lensFilter = new Set(lensArg.split(",").map((s) => s.trim()));
} else if (lensFamilyArg) {
  const rows = q(
    { q: [{ where: [["?e", "lens/id", "?id"], ["?e", "lens/family", "?f"]] }], select: ["id", "f"] },
    db,
  );
  lensFilter = new Set<string>();
  for (const row of rows) {
    if (row["f"] === lensFamilyArg) lensFilter.add(row["id"] as string);
  }
  if (lensFilter.size === 0) {
    console.error(`No lenses found with family '${lensFamilyArg}'.`);
    process.exit(1);
  }
}

// Load entity records into a Map for output
interface EntityRecord {
  id: string;
  lens?: string;
  labels: Record<string, string>;
  description?: string;
  aliases?: string[];
  statements: Map<string, Array<{ value: string; rank?: string; lens?: string; qualifiers?: Record<string, unknown> }>>;
}

function loadEntityRecord(entityId: string): EntityRecord | undefined {
  const rows = q(
    { q: [{ where: [["?e", "entity/id", "?id"]] }], select: ["id"] },
    db,
  );
  const exists = [...rows].some((r) => r["id"] === entityId);
  if (!exists) return undefined;

  // Fetch entity metadata
  const metaRows = q(
    { q: [{ where: [["?e", "entity/id", "?id"], ["?e", "entity/labels", "?labels"]] }], select: ["id", "labels"] },
    db,
  );
  let labels: Record<string, string> = {};
  let description: string | undefined;
  let ownerLens: string | undefined;
  let aliases: string[] | undefined;

  for (const row of metaRows) {
    if (row["id"] === entityId) {
      labels = JSON.parse(row["labels"] as string) as Record<string, string>;
    }
  }
  for (const row of q({ q: [{ where: [["?e", "entity/id", "?id"], ["?e", "entity/description", "?d"]] }], select: ["id", "d"] }, db)) {
    if (row["id"] === entityId) description = row["d"] as string;
  }
  for (const row of q({ q: [{ where: [["?e", "entity/id", "?id"], ["?e", "entity/lens", "?l"]] }], select: ["id", "l"] }, db)) {
    if (row["id"] === entityId) ownerLens = row["l"] as string;
  }
  for (const row of q({ q: [{ where: [["?e", "entity/id", "?id"], ["?e", "entity/aliases", "?a"]] }], select: ["id", "a"] }, db)) {
    if (row["id"] === entityId) aliases = JSON.parse(row["a"] as string) as string[];
  }

  // Fetch statements
  const stmtRows = q(
    { q: [{ where: [
      ["?s", "statement/subject", "?subj"],
      ["?s", "statement/predicate", "?pred"],
      ["?s", "statement/value", "?val"],
      ["?s", "statement/lens", "?lens"],
    ]}], select: ["subj", "pred", "val", "lens"] },
    db,
  );
  const statements = new Map<string, Array<{ value: string; rank?: string; lens?: string }>>();
  for (const row of stmtRows) {
    if (row["subj"] !== entityId) continue;
    const pred = row["pred"] as string;
    if (!statements.has(pred)) statements.set(pred, []);
    statements.get(pred)!.push({ value: row["val"] as string, lens: row["lens"] as string });
  }

  return { id: entityId, lens: ownerLens, labels, description, aliases, statements };
}

function formatEntityText(rec: EntityRecord): string {
  const lines: string[] = [];
  lines.push(`${rec.labels["en"] ?? rec.id} (${rec.id}) [lens: ${rec.lens ?? "?"}]`);
  if (rec.description) lines.push(`  ${rec.description}`);
  if (rec.aliases && rec.aliases.length > 0) lines.push(`  aliases: ${rec.aliases.join(", ")}`);
  lines.push("  statements:");
  for (const [pred, entries] of rec.statements) {
    lines.push(`    ${pred}:`);
    for (const entry of entries) {
      const parts = [`      value: ${entry.value}`];
      if (entry.rank && entry.rank !== "normal") parts.push(`rank: ${entry.rank}`);
      if (entry.lens) parts.push(`lens: ${entry.lens}`);
      lines.push(parts.join("  "));
    }
  }
  return lines.join("\n");
}

function formatEntityJson(rec: EntityRecord): unknown {
  const stmtsObj: Record<string, unknown[]> = {};
  for (const [pred, entries] of rec.statements) stmtsObj[pred] = entries;
  return { id: rec.id, owner_lens: rec.lens, labels: rec.labels, description: rec.description, aliases: rec.aliases, statements: stmtsObj };
}

// Subclass closure: child → set of ancestor ids
function buildSubclassChildren(): Map<string, Set<string>> {
  const children = new Map<string, Set<string>>();
  const stmtRows = q(
    { q: [{ where: [["?s", "statement/predicate", "?pred"], ["?s", "statement/subject", "?subj"], ["?s", "statement/value", "?val"]] }],
      select: ["pred", "subj", "val"] },
    db,
  );
  for (const row of stmtRows) {
    const pred = row["pred"] as string;
    if (!pred.endsWith(":subclass_of")) continue;
    const val = row["val"] as string;
    if (!val.startsWith("@")) continue;
    const parent = val;
    const child  = row["subj"] as string;
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent)!.add(child);
  }
  return children;
}

function buildInstanceChildren(): Map<string, Set<string>> {
  const children = new Map<string, Set<string>>();
  const stmtRows = q(
    { q: [{ where: [["?s", "statement/predicate", "?pred"], ["?s", "statement/subject", "?subj"], ["?s", "statement/value", "?val"]] }],
      select: ["pred", "subj", "val"] },
    db,
  );
  for (const row of stmtRows) {
    const pred = row["pred"] as string;
    if (!pred.endsWith(":instance_of")) continue;
    const val = row["val"] as string;
    if (!val.startsWith("@")) continue;
    const cls    = val;
    const entity = row["subj"] as string;
    if (!children.has(cls)) children.set(cls, new Set());
    children.get(cls)!.add(entity);
  }
  return children;
}

// Collect entity lens for filtering
function entityLensMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const row of q({ q: [{ where: [["?e", "entity/id", "?id"], ["?e", "entity/lens", "?l"]] }], select: ["id", "l"] }, db)) {
    m.set(row["id"] as string, row["l"] as string);
  }
  return m;
}

function getLabel(entityId: string): string {
  for (const row of q({ q: [{ where: [["?e", "entity/id", "?id"], ["?e", "entity/labels", "?labels"]] }], select: ["id", "labels"] }, db)) {
    if (row["id"] === entityId) {
      const parsed = JSON.parse(row["labels"] as string) as Record<string, string>;
      return parsed["en"] ?? entityId;
    }
  }
  return entityId;
}

// Expand subclasses of a class (BFS from direct children maps)
function subclassesOf(classId: string, t: boolean, childrenMap: Map<string, Set<string>>, lf?: Set<string>): string[] {
  const result: string[] = [];
  const queue = [...(childrenMap.get(classId) ?? [])];
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (!lf || lf.has(id)) result.push(id);  // filter by lens where applicable
    if (t) for (const c of childrenMap.get(id) ?? []) if (!visited.has(c)) queue.push(c);
  }
  return result;
}

function instancesOf(classId: string, t: boolean, subChildren: Map<string, Set<string>>, instChildren: Map<string, Set<string>>, lf?: Set<string>): string[] {
  // When transitive: all subclasses of classId, then instances of each
  const classes = t ? [classId, ...subclassesOf(classId, true, subChildren)] : [classId];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const cls of classes) {
    for (const inst of instChildren.get(cls) ?? []) {
      if (seen.has(inst)) continue;
      seen.add(inst);
      if (!lf || lf.has(inst)) result.push(inst);
    }
  }
  return result;
}

if (entityArg) {
  const id = stripAt(entityArg);
  const rec = loadEntityRecord(id);
  if (!rec) {
    console.error(`Entity '${id}' not found.`);
    process.exit(1);
  }
  console.log(format === "text" ? formatEntityText(rec) : JSON.stringify(formatEntityJson(rec), null, 2));

} else if (instanceOfArg) {
  const classId = stripAt(instanceOfArg);
  const subChildren  = buildSubclassChildren();
  const instChildren = buildInstanceChildren();
  const elMap = entityLensMap();
  const lf = lensFilter ? new Set([...lensFilter].flatMap((l) => {
    const ids: string[] = [];
    for (const [eid, elens] of elMap) if (elens === l) ids.push(eid);
    return ids;
  })) : undefined;
  const ids = instancesOf(classId, transitive, subChildren, instChildren, lf);
  if (format === "text") {
    for (const id of ids) console.log(`${id}  ${getLabel(id)}`);
  } else {
    console.log(JSON.stringify(ids.map((id) => ({ id, label: getLabel(id) })), null, 2));
  }

} else if (subclassOfArg) {
  const classId = stripAt(subclassOfArg);
  const subChildren = buildSubclassChildren();
  const elMap = entityLensMap();
  const lf = lensFilter ? new Set([...lensFilter].flatMap((l) => {
    const ids: string[] = [];
    for (const [eid, elens] of elMap) if (elens === l) ids.push(eid);
    return ids;
  })) : undefined;
  const ids = subclassesOf(classId, transitive, subChildren, lf);
  if (format === "text") {
    for (const id of ids) console.log(`${id}  ${getLabel(id)}`);
  } else {
    console.log(JSON.stringify(ids.map((id) => ({ id, label: getLabel(id) })), null, 2));
  }

} else if (hasPredicateArg) {
  const pred = hasPredicateArg;
  const elMap = entityLensMap();
  const stmtRows = q(
    { q: [{ where: [["?s", "statement/predicate", "?pred"], ["?s", "statement/subject", "?subj"]] }],
      select: ["pred", "subj"] },
    db,
  );
  const subjects = new Set<string>();
  for (const row of stmtRows) {
    if (row["pred"] === pred) subjects.add(row["subj"] as string);
  }
  const results = [...subjects].filter((id) => !lensFilter || lensFilter.has(elMap.get(id) ?? ""));
  if (format === "text") {
    for (const id of results) console.log(`${id}  ${getLabel(id)}`);
  } else {
    console.log(JSON.stringify(results.map((id) => ({ id, label: getLabel(id) })), null, 2));
  }

} else if (lensFamilyArg && !entityArg && !instanceOfArg && !subclassOfArg && !hasPredicateArg) {
  const elMap = entityLensMap();
  const results = [...elMap.entries()]
    .filter(([, l]) => lensFilter?.has(l))
    .map(([id]) => id);
  if (format === "text") {
    for (const id of results) console.log(`${id}  ${getLabel(id)}  [lens: ${elMap.get(id)}]`);
  } else {
    console.log(JSON.stringify(results.map((id) => ({ id, label: getLabel(id), lens: elMap.get(id) })), null, 2));
  }

} else {
  console.error(
    "Usage:\n" +
    "  bun run query2 --entity <id>\n" +
    "  bun run query2 --instance-of <@id> [--transitive]\n" +
    "  bun run query2 --subclass-of <@id> [--transitive]\n" +
    "  bun run query2 --has-predicate <predicate-id>\n" +
    "  Add --format text for human-readable output.\n" +
    "  Add --lens <lens1,lens2,...> to restrict to specific lenses.\n" +
    "  Add --lens-family <family> to load all lenses with a matching family."
  );
  process.exit(1);
}
