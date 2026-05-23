import { loadLensSet, Entity, StatementEntry, Predicate, ExtensionRecord } from "./load.ts";

export interface TaggedStatement {
  value: string | number | boolean | import("./load.ts").SentinelValue;
  source?: string;
  qualifiers?: Record<string, string | number | boolean>;
  rank?: "preferred" | "normal" | "deprecated";
  /** Which lens's entities.jsonl this statement came from */
  origin_lens: string;
}

export interface MergedEntity {
  id: string;
  labels: Record<string, string>;
  aliases?: string[];
  description?: string;
  /** Union of all statements from any lens that mentions this entity */
  statements: Record<string, TaggedStatement[]>;
  /** The lens that owns/introduces this entity (first occurrence) */
  owner_lens: string;
}

export interface Graph {
  entities: Map<string, MergedEntity>;
  predicates: Map<string, Predicate>;
  // forward index: predicate -> array of {subject, entry}
  forward: Map<string, Array<{ subject: string; entry: TaggedStatement }>>;
  // reverse index: object entity id -> array of {subject, predicate, entry}
  reverse: Map<string, Array<{ subject: string; predicate: string; entry: TaggedStatement }>>;
  /** Which lenses are loaded */
  loadedLens: Set<string>;
}

function stripAt(id: string): string {
  return id.startsWith("@") ? id.slice(1) : id;
}

export function buildGraph(lensFilter?: string[], preloaded?: import("./load.ts").LoadedLensSet): Graph {
  const lensSet = preloaded ?? loadLensSet(lensFilter);

  const entities = new Map<string, MergedEntity>();
  const predicates = new Map<string, Predicate>();
  const loadedLens = new Set<string>();

  // Track which lens first introduced each entity (owner)
  const entityOwner = new Map<string, string>();

  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    loadedLens.add(lensId);

    // Index predicates
    for (const { record } of lens.predicates) {
      predicates.set(record.id, record);
    }

    // Merge entities
    for (const { record } of lens.entities) {
      const existing = entities.get(record.id);
      if (!existing) {
        entityOwner.set(record.id, lensId);
        const merged: MergedEntity = {
          id: record.id,
          labels: { ...record.labels },
          aliases: record.aliases ? [...record.aliases] : undefined,
          description: record.description,
          statements: {},
          owner_lens: lensId,
        };
        for (const [pred, entries] of Object.entries(record.statements)) {
          merged.statements[pred] = entries.map((e) => ({ ...e, origin_lens: lensId }));
        }
        entities.set(record.id, merged);
      } else {
        // Merge statements — add any new predicate entries from this lens
        for (const [pred, entries] of Object.entries(record.statements)) {
          if (!existing.statements[pred]) {
            existing.statements[pred] = [];
          }
          for (const e of entries) {
            existing.statements[pred].push({ ...e, origin_lens: lensId });
          }
        }
        // Merge labels (don't overwrite existing)
        for (const [lang, label] of Object.entries(record.labels)) {
          if (!existing.labels[lang]) existing.labels[lang] = label;
        }
      }
    }
  }

  // Apply extension records after all definitions are loaded
  for (const lensId of lensSet.order) {
    const lens = lensSet.lenses.get(lensId)!;
    for (const { record: ext } of lens.extensions) {
      const targetId = ext.extends.startsWith("@") ? ext.extends.slice(1) : ext.extends;
      const target = entities.get(targetId);
      if (!target) {
        // dangling-extension — will be reported by validator
        continue;
      }
      // A lens must not extend an entity it owns
      if (entityOwner.get(targetId) === lensId) {
        // own-entity-extension — will be reported by validator
        continue;
      }
      // Merge extension statements into target, tagging with extending lens
      for (const [pred, entries] of Object.entries(ext.statements)) {
        if (!target.statements[pred]) {
          target.statements[pred] = [];
        }
        for (const e of entries) {
          target.statements[pred].push({ ...e, origin_lens: lensId });
        }
      }
    }
  }

  // Build forward/reverse indices
  const forward = new Map<string, Array<{ subject: string; entry: TaggedStatement }>>();
  const reverse = new Map<string, Array<{ subject: string; predicate: string; entry: TaggedStatement }>>();

  for (const [subjectId, entity] of entities) {
    for (const [predicate, entries] of Object.entries(entity.statements)) {
      if (!forward.has(predicate)) forward.set(predicate, []);
      for (const entry of entries) {
        forward.get(predicate)!.push({ subject: subjectId, entry });

        if (typeof entry.value === "string" && entry.value.startsWith("@")) {
          const objectId = stripAt(entry.value);
          if (!reverse.has(objectId)) reverse.set(objectId, []);
          reverse.get(objectId)!.push({ subject: subjectId, predicate, entry });
        }
      }
    }
  }

  return { entities, predicates, forward, reverse, loadedLens };
}

export function getEntity(graph: Graph, id: string): MergedEntity | undefined {
  return graph.entities.get(stripAt(id));
}

export function neighbors(graph: Graph, entityId: string, predicateId: string): string[] {
  const entity = graph.entities.get(stripAt(entityId));
  if (!entity) return [];
  const entries = entity.statements[predicateId] ?? [];
  const result: string[] = [];
  for (const entry of entries) {
    if (typeof entry.value === "string" && entry.value.startsWith("@")) {
      result.push(stripAt(entry.value));
    }
  }
  return result;
}

export function statementsByPredicate(graph: Graph, entityId: string): Record<string, TaggedStatement[]> {
  const entity = graph.entities.get(stripAt(entityId));
  if (!entity) return {};
  return entity.statements;
}

// ---- Transitive class hierarchy helpers ----

/** Memoized: returns all superclasses of classId (inclusive of direct parents) via subclass_of. */
const superclassCache = new Map<string, Set<string>>();

export function clearTransitiveCache(): void {
  superclassCache.clear();
  instanceOfClassCache.clear();
}

function getSuperclasses(graph: Graph, classId: string, visited = new Set<string>()): Set<string> {
  if (superclassCache.has(classId)) return superclassCache.get(classId)!;
  if (visited.has(classId)) return new Set();

  const result = new Set<string>();
  visited.add(classId);
  const parents = neighbors(graph, classId, "subclass_of");
  for (const parent of parents) {
    result.add(parent);
    for (const ancestor of getSuperclasses(graph, parent, visited)) {
      result.add(ancestor);
    }
  }
  superclassCache.set(classId, result);
  return result;
}

/** Returns true if entity is transitively instance_of the given classId. */
const instanceOfClassCache = new Map<string, Map<string, boolean>>();

export function isInstanceOf(graph: Graph, entityId: string, classId: string): boolean {
  const id = stripAt(entityId);
  const cid = stripAt(classId);

  if (!instanceOfClassCache.has(id)) instanceOfClassCache.set(id, new Map());
  const entityCache = instanceOfClassCache.get(id)!;
  if (entityCache.has(cid)) return entityCache.get(cid)!;

  const entity = graph.entities.get(id);
  if (!entity) {
    entityCache.set(cid, false);
    return false;
  }

  // Direct instance_of values
  const directClasses = (entity.statements["instance_of"] ?? [])
    .filter((e) => typeof e.value === "string" && (e.value as string).startsWith("@"))
    .map((e) => stripAt(e.value as string));

  // Check: is cid in directClasses, or is cid a superclass of any directClass?
  for (const dc of directClasses) {
    if (dc === cid) {
      entityCache.set(cid, true);
      return true;
    }
    // dc subclass_of ... subclass_of cid ?
    const ancestors = getSuperclasses(graph, dc);
    if (ancestors.has(cid)) {
      entityCache.set(cid, true);
      return true;
    }
  }

  entityCache.set(cid, false);
  return false;
}

export function subclassesOf(
  graph: Graph,
  classId: string,
  options: { transitive: boolean; lensFilter?: Set<string> } = { transitive: true }
): string[] {
  const target = stripAt(classId);
  const result: string[] = [];
  const visited = new Set<string>();

  if (options.transitive) {
    const queue = [target];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const reverseEntries = graph.reverse.get(current) ?? [];
      for (const { subject, predicate, entry } of reverseEntries) {
        if (
          predicate === "subclass_of" &&
          !visited.has(subject) &&
          (!options.lensFilter || options.lensFilter.has(entry.origin_lens))
        ) {
          visited.add(subject);
          result.push(subject);
          queue.push(subject);
        }
      }
    }
  } else {
    const reverseEntries = graph.reverse.get(target) ?? [];
    for (const { subject, predicate, entry } of reverseEntries) {
      if (
        predicate === "subclass_of" &&
        (!options.lensFilter || options.lensFilter.has(entry.origin_lens))
      ) {
        result.push(subject);
      }
    }
  }

  return result;
}

export function superclassesOf(graph: Graph, classId: string): string[] {
  return [...getSuperclasses(graph, stripAt(classId))];
}

export function instancesOf(
  graph: Graph,
  classId: string,
  options: { transitive: boolean; lensFilter?: Set<string> } = { transitive: false }
): string[] {
  const target = stripAt(classId);
  const classIds = new Set<string>([target]);

  if (options.transitive) {
    for (const sub of subclassesOf(graph, target, { transitive: true })) {
      classIds.add(sub);
    }
  }

  const result: string[] = [];
  for (const cid of classIds) {
    const reverseEntries = graph.reverse.get(cid) ?? [];
    for (const { subject, predicate, entry } of reverseEntries) {
      if (
        predicate === "instance_of" &&
        (!options.lensFilter || options.lensFilter.has(entry.origin_lens))
      ) {
        result.push(subject);
      }
    }
  }

  return result;
}
