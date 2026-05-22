import { loadEntities, loadPredicates, Entity, StatementEntry } from "./load.ts";

export interface Graph {
  entities: Map<string, Entity>;
  // forward index: predicate -> array of {subject, entry}
  forward: Map<string, Array<{ subject: string; entry: StatementEntry }>>;
  // reverse index: object entity id -> array of {subject, predicate, entry}
  reverse: Map<string, Array<{ subject: string; predicate: string; entry: StatementEntry }>>;
  predicateIds: Set<string>;
}

function stripAt(id: string): string {
  return id.startsWith("@") ? id.slice(1) : id;
}

export function buildGraph(): Graph {
  const entityRecords = loadEntities();
  const predicateRecords = loadPredicates();

  const entities = new Map<string, Entity>();
  for (const { record } of entityRecords) {
    entities.set(record.id, record);
  }

  const predicateIds = new Set<string>();
  for (const { record } of predicateRecords) {
    predicateIds.add(record.id);
  }

  const forward = new Map<string, Array<{ subject: string; entry: StatementEntry }>>();
  const reverse = new Map<string, Array<{ subject: string; predicate: string; entry: StatementEntry }>>();

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

  return { entities, forward, reverse, predicateIds };
}

export function getEntity(graph: Graph, id: string): Entity | undefined {
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

export function statementsByPredicate(graph: Graph, entityId: string): Record<string, StatementEntry[]> {
  const entity = graph.entities.get(stripAt(entityId));
  if (!entity) return {};
  return entity.statements;
}

export function subclassesOf(
  graph: Graph,
  classId: string,
  options: { transitive: boolean } = { transitive: true }
): string[] {
  const target = stripAt(classId);
  const result: string[] = [];
  const visited = new Set<string>();

  if (options.transitive) {
    const queue = [target];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const reverseEntries = graph.reverse.get(current) ?? [];
      for (const { subject, predicate } of reverseEntries) {
        if (predicate === "subclass_of" && !visited.has(subject)) {
          visited.add(subject);
          result.push(subject);
          queue.push(subject);
        }
      }
    }
  } else {
    const reverseEntries = graph.reverse.get(target) ?? [];
    for (const { subject, predicate } of reverseEntries) {
      if (predicate === "subclass_of") {
        result.push(subject);
      }
    }
  }

  return result;
}

export function superclassesOf(graph: Graph, classId: string): string[] {
  const start = stripAt(classId);
  const result: string[] = [];
  const visited = new Set<string>();
  const queue = [start];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const parents = neighbors(graph, current, "subclass_of");
    for (const parent of parents) {
      if (!visited.has(parent)) {
        visited.add(parent);
        result.push(parent);
        queue.push(parent);
      }
    }
  }

  return result;
}

export function instancesOf(
  graph: Graph,
  classId: string,
  options: { transitive: boolean } = { transitive: false }
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
    for (const { subject, predicate } of reverseEntries) {
      if (predicate === "instance_of") {
        result.push(subject);
      }
    }
  }

  return result;
}
