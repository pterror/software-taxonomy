// tree.ts — renders a subclass tree from the data store.
//
//   --root <@id>             root entity (default: @class:software)
//   --lens <l1,l2,...>       restrict tree edges to these lens ids

import { loadData } from "./lib/load.js";
import { q } from "./lib/store.js";

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

let rootId = getArg("--root") ?? "class:software";
if (rootId.startsWith("@")) rootId = rootId.slice(1);
rootId = `@${rootId}`;

const lensArg = getArg("--lens");
const lensFilter: Set<string> | undefined = lensArg
  ? new Set(lensArg.split(",").map((s) => s.trim()))
  : undefined;

const db = loadData();

// Check root exists
const entityRows = q({ q: [{ where: [["?e", "entity/id", "?id"]] }], select: ["id"] }, db);
const allEntityIds = new Set<string>([...entityRows].map((r) => r["id"] as string));
if (!allEntityIds.has(rootId)) {
  console.error(`Root entity '${rootId}' not found.`);
  process.exit(1);
}

// Build children maps once
interface EdgeMaps {
  subclassChildren: Map<string, string[]>;  // parent → direct subclasses
  instanceChildren: Map<string, string[]>;  // class → direct instances
  stmtLens: Map<string, string>;            // "<subject>|<value>" → lens id (for filtering)
}

function buildEdgeMaps(): EdgeMaps {
  const subclassChildren = new Map<string, string[]>();
  const instanceChildren = new Map<string, string[]>();
  const stmtLens = new Map<string, string>();

  const stmtRows = q(
    { q: [{ where: [
      ["?s", "statement/predicate", "?pred"],
      ["?s", "statement/subject", "?subj"],
      ["?s", "statement/value", "?val"],
      ["?s", "statement/lens", "?lens"],
    ]}], select: ["pred", "subj", "val", "lens"] },
    db,
  );

  for (const row of stmtRows) {
    const pred  = row["pred"] as string;
    const subj  = row["subj"] as string;
    const val   = row["val"] as string;
    const lens  = row["lens"] as string;
    if (!val.startsWith("@")) continue;

    const edgeKey = `${subj}|${val}`;
    if (pred.endsWith(":subclass_of")) {
      stmtLens.set(edgeKey, lens);
      const arr = subclassChildren.get(val) ?? [];
      if (!arr.includes(subj)) arr.push(subj);
      subclassChildren.set(val, arr);
    } else if (pred.endsWith(":instance_of")) {
      stmtLens.set(edgeKey, lens);
      const arr = instanceChildren.get(val) ?? [];
      if (!arr.includes(subj)) arr.push(subj);
      instanceChildren.set(val, arr);
    }
  }

  return { subclassChildren, instanceChildren, stmtLens };
}

const { subclassChildren, instanceChildren, stmtLens } = buildEdgeMaps();

function passesLensFilter(childId: string, parentId: string): boolean {
  if (!lensFilter) return true;
  const lens = stmtLens.get(`${childId}|${parentId}`);
  return lens !== undefined && lensFilter.has(lens);
}

function directSubclasses(id: string): string[] {
  return (subclassChildren.get(id) ?? []).filter((c) => passesLensFilter(c, id));
}

function directInstances(id: string): string[] {
  return (instanceChildren.get(id) ?? []).filter((c) => passesLensFilter(c, id));
}

function getLabel(id: string): string {
  for (const row of q({ q: [{ where: [["?e", "entity/id", "?id"], ["?e", "entity/labels", "?lbl"]] }], select: ["id", "lbl"] }, db)) {
    if (row["id"] === id) {
      const parsed = JSON.parse(row["lbl"] as string) as Record<string, string>;
      return parsed["en"] ?? id;
    }
  }
  return id;
}

function renderNode(id: string, prefix: string, isLast: boolean, visited: Set<string>): void {
  if (visited.has(id)) return; // cycle guard
  visited.add(id);
  const connector = isLast ? "└─" : "├─";
  console.log(`${prefix}${connector} ${getLabel(id)}`);

  const childPrefix = prefix + (isLast ? "   " : "│  ");
  const childClasses    = directSubclasses(id);
  const childInstances  = directInstances(id);

  childClasses.forEach((childId, i) => {
    const last = i === childClasses.length - 1 && childInstances.length === 0;
    renderNode(childId, childPrefix, last, visited);
  });

  childInstances.forEach((instId, i) => {
    const last = i === childInstances.length - 1;
    const instConnector = last ? "└─" : "├─";
    console.log(`${childPrefix}${instConnector} ● ${getLabel(instId)}`);
  });
}

console.log(getLabel(rootId));

const topClasses    = directSubclasses(rootId);
const topInstances  = directInstances(rootId);
const visited = new Set<string>([rootId]);

topClasses.forEach((childId, i) => {
  const last = i === topClasses.length - 1 && topInstances.length === 0;
  renderNode(childId, "", last, visited);
});

topInstances.forEach((instId, i) => {
  const last = i === topInstances.length - 1;
  const connector = last ? "└─" : "├─";
  console.log(`${connector} ● ${getLabel(instId)}`);
});
