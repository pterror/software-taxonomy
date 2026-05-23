import { buildGraph, getEntity, instancesOf, subclassesOf, MergedEntity } from "./lib/graph.ts";
import { loadLensSet } from "./lib/load.ts";

// Alias for readability
type Entity = MergedEntity;

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const entityArg = getArg("--entity");
const instanceOfArg = getArg("--instance-of");
const subclassOfArg = getArg("--subclass-of");
const hasPredicateArg = getArg("--has-predicate");
const transitive = hasFlag("--transitive");
const format = getArg("--format") ?? "json";
const lensArg = getArg("--lens");
const lensFamilyArg = getArg("--lens-family");

function stripAt(id: string): string {
  return id.startsWith("@") ? id.slice(1) : id;
}

// Resolve lens filter from --lens or --lens-family
let lensFilter: string[] | undefined;
if (lensArg) {
  lensFilter = lensArg.split(",").map((s) => s.trim());
} else if (lensFamilyArg) {
  // Load all manifests and find lenses with matching family
  const fullSet = loadLensSet();
  const matching: string[] = [];
  for (const [id, lens] of fullSet.lenses) {
    if (lens.manifest.family === lensFamilyArg) {
      matching.push(id);
    }
  }
  if (matching.length === 0) {
    console.error(`No lenses found with family '${lensFamilyArg}'.`);
    process.exit(1);
  }
  lensFilter = matching;
}

const graph = buildGraph(lensFilter);
const lensFilterSet = lensFilter ? new Set(lensFilter) : undefined;

function formatEntity(entity: Entity): string {
  if (format === "text") {
    const lines: string[] = [];
    lines.push(`${entity.labels["en"] ?? entity.id} (${entity.id}) [lens: ${entity.owner_lens}]`);
    if (entity.description) lines.push(`  ${entity.description}`);
    if (entity.aliases && entity.aliases.length > 0) {
      lines.push(`  aliases: ${entity.aliases.join(", ")}`);
    }
    lines.push("  statements:");
    for (const [pred, entries] of Object.entries(entity.statements)) {
      lines.push(`    ${pred}:`);
      for (const entry of entries) {
        const parts: string[] = [`      value: ${entry.value}`];
        if (entry.rank && entry.rank !== "normal") parts.push(`rank: ${entry.rank}`);
        if (entry.source) parts.push(`source: ${entry.source}`);
        if (entry.origin_lens) parts.push(`lens: ${entry.origin_lens}`);
        if (entry.qualifiers) {
          const qParts = Object.entries(entry.qualifiers).map(([k, v]) => `${k}=${v}`);
          parts.push(`qualifiers: {${qParts.join(", ")}}`);
        }
        lines.push(parts.join("  "));
      }
    }
    return lines.join("\n");
  }
  return JSON.stringify(entity, null, 2);
}

if (entityArg) {
  const id = stripAt(entityArg);
  const entity = getEntity(graph, id);
  if (!entity) {
    console.error(`Entity '${id}' not found.`);
    process.exit(1);
  }
  console.log(formatEntity(entity));
} else if (instanceOfArg) {
  const classId = stripAt(instanceOfArg);
  const ids = instancesOf(graph, classId, { transitive, lensFilter: lensFilterSet });
  if (format === "text") {
    for (const id of ids) {
      const e = getEntity(graph, id);
      console.log(`${id}  ${e?.labels["en"] ?? ""}`);
    }
  } else {
    const entities = ids.map((id) => getEntity(graph, id)).filter(Boolean);
    console.log(JSON.stringify(entities, null, 2));
  }
} else if (subclassOfArg) {
  const classId = stripAt(subclassOfArg);
  const ids = subclassesOf(graph, classId, { transitive, lensFilter: lensFilterSet });
  if (format === "text") {
    for (const id of ids) {
      const e = getEntity(graph, id);
      console.log(`${id}  ${e?.labels["en"] ?? ""}`);
    }
  } else {
    const entities = ids.map((id) => getEntity(graph, id)).filter(Boolean);
    console.log(JSON.stringify(entities, null, 2));
  }
} else if (hasPredicateArg) {
  const pred = hasPredicateArg;
  const results: Entity[] = [];
  for (const [, entity] of graph.entities) {
    if (pred in entity.statements) {
      // Filter by lens if specified
      if (!lensFilterSet || lensFilterSet.has(entity.owner_lens)) {
        results.push(entity);
      }
    }
  }
  if (format === "text") {
    for (const e of results) {
      console.log(`${e.id}  ${e.labels["en"] ?? ""}`);
    }
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
} else if (lensFamilyArg && !entityArg && !instanceOfArg && !subclassOfArg && !hasPredicateArg) {
  // --lens-family with no other filter: list all entities owned by matching lenses
  const results: MergedEntity[] = [];
  for (const [, entity] of graph.entities) {
    if (lensFilterSet && lensFilterSet.has(entity.owner_lens)) {
      results.push(entity);
    }
  }
  if (format === "text") {
    for (const e of results) {
      console.log(`${e.id}  ${e.labels["en"] ?? ""}  [lens: ${e.owner_lens}]`);
    }
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
} else {
  console.error(
    "Usage:\n" +
    "  bun run query --entity <id>\n" +
    "  bun run query --instance-of <@id> [--transitive]\n" +
    "  bun run query --subclass-of <@id> [--transitive]\n" +
    "  bun run query --has-predicate <predicate-id>\n" +
    "  Add --format text for human-readable output.\n" +
    "  Add --lens <lens1,lens2,...> to restrict to specific lenses.\n" +
    "  Add --lens-family <family> to load all lenses with a matching family.\n" +
    "  --lens-family alone lists all entities owned by matching-family lenses."
  );
  process.exit(1);
}
