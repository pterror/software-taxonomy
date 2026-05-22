import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadJsonl } from "./lib/load.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, "../../data");

interface Clade {
  id: string;
  parent: string | null;
}

interface Species {
  id: string;
  name: string;
  clade: string;
  features?: Record<string, unknown>;
  [key: string]: unknown;
}

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const inClade = getArg("--in-clade");
const featureKey = getArg("--feature");
const hasTraitArg = getArg("--has-trait");

const clades = loadJsonl<Clade>(resolve(dataDir, "clades.jsonl")).map((r) => r.record);
const species = loadJsonl<Species>(resolve(dataDir, "species.jsonl")).map((r) => r.record);

function buildDescendants(rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const c of clades) {
    if (c.parent !== null) {
      if (!children.has(c.parent)) children.set(c.parent, []);
      children.get(c.parent)!.push(c.id);
    }
  }

  const result = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.add(id);
    for (const child of children.get(id) ?? []) {
      queue.push(child);
    }
  }
  return result;
}

let results: Species[] = species;

if (inClade) {
  const descendants = buildDescendants(inClade);
  results = results.filter((sp) => descendants.has(sp.clade));
}

if (featureKey) {
  results = results.filter(
    (sp) => sp.features != null && featureKey in sp.features
  );
}

if (hasTraitArg) {
  const eqIdx = hasTraitArg.indexOf("=");
  if (eqIdx === -1) {
    console.error(`--has-trait requires key=value format, got: ${hasTraitArg}`);
    process.exit(1);
  }
  const key = hasTraitArg.slice(0, eqIdx);
  const value = hasTraitArg.slice(eqIdx + 1);
  results = results.filter(
    (sp) =>
      sp.features != null &&
      key in sp.features &&
      String(sp.features[key]) === value
  );
}

console.log(JSON.stringify(results, null, 2));
