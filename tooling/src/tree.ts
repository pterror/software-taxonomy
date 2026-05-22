import { buildGraph, subclassesOf, instancesOf, getEntity } from "./lib/graph.ts";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
let rootId = rootIdx !== -1 ? args[rootIdx + 1] : "software";
// strip leading @ if passed
if (rootId.startsWith("@")) rootId = rootId.slice(1);

const graph = buildGraph();

const rootEntity = getEntity(graph, rootId);
if (!rootEntity) {
  console.error(`Root entity '${rootId}' not found.`);
  process.exit(1);
}

// Build parent map for the subtree rooted at rootId
// We need direct children (subclassesOf non-transitive) for tree rendering
function directSubclasses(id: string): string[] {
  return subclassesOf(graph, id, { transitive: false });
}

function directInstances(id: string): string[] {
  return instancesOf(graph, id, { transitive: false });
}

function getLabel(id: string): string {
  const entity = getEntity(graph, id);
  return entity?.labels["en"] ?? id;
}

function renderNode(id: string, prefix: string, isLast: boolean): void {
  const connector = isLast ? "└─" : "├─";
  console.log(`${prefix}${connector} ${getLabel(id)}`);

  const childPrefix = prefix + (isLast ? "   " : "│  ");
  const childClasses = directSubclasses(id);
  const childInstances = directInstances(id);
  const totalChildren = childClasses.length + childInstances.length;

  childClasses.forEach((childId, i) => {
    const last = i === childClasses.length - 1 && childInstances.length === 0;
    renderNode(childId, childPrefix, last);
  });

  childInstances.forEach((instId, i) => {
    const last = i === childInstances.length - 1;
    const instConnector = last ? "└─" : "├─";
    console.log(`${childPrefix}${instConnector} ● ${getLabel(instId)}`);
  });
}

console.log(getLabel(rootId));

const topClasses = directSubclasses(rootId);
const topInstances = directInstances(rootId);

topClasses.forEach((childId, i) => {
  const last = i === topClasses.length - 1 && topInstances.length === 0;
  renderNode(childId, "", last);
});

topInstances.forEach((instId, i) => {
  const last = i === topInstances.length - 1;
  const connector = last ? "└─" : "├─";
  console.log(`${connector} ● ${getLabel(instId)}`);
});
