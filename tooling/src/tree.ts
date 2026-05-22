import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadJsonl } from "./lib/load.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, "../../data");

interface Clade {
  id: string;
  name: string;
  parent: string | null;
  rank_hint?: string;
}

interface Species {
  id: string;
  name: string;
  clade: string;
}

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const rootId = rootIdx !== -1 ? args[rootIdx + 1] : "cellularia";

const clades = loadJsonl<Clade>(resolve(dataDir, "clades.jsonl")).map((r) => r.record);
const species = loadJsonl<Species>(resolve(dataDir, "species.jsonl")).map((r) => r.record);

const cladeChildren = new Map<string, string[]>();
const cladeById = new Map<string, Clade>();

for (const clade of clades) {
  cladeById.set(clade.id, clade);
  if (!cladeChildren.has(clade.id)) cladeChildren.set(clade.id, []);
  if (clade.parent !== null) {
    if (!cladeChildren.has(clade.parent)) cladeChildren.set(clade.parent, []);
    cladeChildren.get(clade.parent)!.push(clade.id);
  }
}

const speciesByClade = new Map<string, Species[]>();
for (const sp of species) {
  if (!speciesByClade.has(sp.clade)) speciesByClade.set(sp.clade, []);
  speciesByClade.get(sp.clade)!.push(sp);
}

function renderTree(id: string, prefix: string, isLast: boolean): void {
  const clade = cladeById.get(id);
  if (!clade) {
    console.error(`Unknown clade: ${id}`);
    return;
  }

  const connector = isLast ? "└─" : "├─";
  const rankTag = clade.rank_hint ? ` [${clade.rank_hint}]` : "";
  console.log(`${prefix}${connector} ${clade.name}${rankTag}`);

  const childPrefix = prefix + (isLast ? "   " : "│  ");

  const childClades = cladeChildren.get(id) ?? [];
  const childSpecies = speciesByClade.get(id) ?? [];
  const totalChildren = childClades.length + childSpecies.length;

  childClades.forEach((childId, i) => {
    const last = i === childClades.length - 1 && childSpecies.length === 0;
    renderTree(childId, childPrefix, last);
  });

  childSpecies.forEach((sp, i) => {
    const last = i === childSpecies.length - 1;
    const spConnector = last ? "└─" : "├─";
    console.log(`${childPrefix}${spConnector} ● ${sp.name}`);
  });
}

if (!cladeById.has(rootId)) {
  console.error(`Root clade '${rootId}' not found.`);
  process.exit(1);
}

const root = cladeById.get(rootId)!;
const rankTag = root.rank_hint ? ` [${root.rank_hint}]` : "";
console.log(`${root.name}${rankTag}`);

const rootChildren = cladeChildren.get(rootId) ?? [];
const rootSpecies = speciesByClade.get(rootId) ?? [];

rootChildren.forEach((childId, i) => {
  const last = i === rootChildren.length - 1 && rootSpecies.length === 0;
  renderTree(childId, "", last);
});

rootSpecies.forEach((sp, i) => {
  const last = i === rootSpecies.length - 1;
  const connector = last ? "└─" : "├─";
  console.log(`${connector} ● ${sp.name}`);
});
