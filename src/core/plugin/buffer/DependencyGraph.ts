/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { Logger } from "../../../utils/Logger";
import { MANY_TO_ONE_TOKEN } from "../../../decorators/ManyToOne";
import { ONE_TO_ONE_TOKEN } from "../../../decorators/OneToOne";

const logger = new Logger("DependencyGraph");

/**
 * Returns the Set stored under `key`, initializing an empty one on first
 * access. Flush must never die on a missing key: the sort runs mid-flush,
 * so a broken seeding assumption has to degrade to "no edges", not throw.
 */
function edgeSet(
  map: Map<ClazzType<any>, Set<ClazzType<any>>>,
  key: ClazzType<any>,
): Set<ClazzType<any>> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/**
 * Build a dependency graph from @ManyToOne and @OneToOne(joinColumn) metadata.
 * A child "depends on" its parent (the entity it references via FK).
 *
 * Returns entities in topological order (parents first) using Kahn's algorithm.
 * On cycle detection, logs a warning naming the entities on the cycle and
 * falls back to the original order.
 */
export function topologicalSort(entityClasses: ClazzType<any>[]): ClazzType<any>[] {
  if (entityClasses.length <= 1) return [...entityClasses];

  const classSet = new Set(entityClasses);
  // adjacency: Map<entity, Set<entities it depends on>>
  const deps = new Map<ClazzType<any>, Set<ClazzType<any>>>();
  // reverse adjacency for in-degree tracking
  const dependents = new Map<ClazzType<any>, Set<ClazzType<any>>>();

  for (const cls of classSet) {
    // @ManyToOne → cls depends on parent
    const m2oMeta: any[] = Reflect.getMetadata(MANY_TO_ONE_TOKEN, cls) ?? [];
    for (const m of m2oMeta) {
      const parent = typeof m.getMappingEntity === "function" ? m.getMappingEntity() : m.type;
      if (parent && classSet.has(parent) && parent !== cls) {
        edgeSet(deps, cls).add(parent);
        edgeSet(dependents, parent).add(cls);
      }
    }

    // @OneToOne(joinColumn) → owning side depends on target
    const o2oMeta: any[] = Reflect.getMetadata(ONE_TO_ONE_TOKEN, cls) ?? [];
    for (const m of o2oMeta) {
      if (m.joinColumn) {
        const target = typeof m.getRelatedEntity === "function" ? m.getRelatedEntity() : null;
        if (target && classSet.has(target) && target !== cls) {
          edgeSet(deps, cls).add(target);
          edgeSet(dependents, target).add(cls);
        }
      }
    }
  }

  // Kahn's algorithm — every lookup tolerates an absent key (degree 0 / no
  // dependents) instead of asserting the maps were fully pre-seeded.
  const inDegree = new Map<ClazzType<any>, number>();
  const queue: ClazzType<any>[] = [];
  for (const cls of classSet) {
    const degree = deps.get(cls)?.size ?? 0;
    inDegree.set(cls, degree);
    if (degree === 0) queue.push(cls);
  }

  const sorted: ClazzType<any>[] = [];
  while (queue.length > 0) {
    const node = queue.shift() as ClazzType<any>;
    sorted.push(node);
    for (const dep of dependents.get(node) ?? []) {
      const newDeg = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  // Cycle detected — warn with the entities still holding unresolved FK
  // dependencies and fall back to the original order so flush proceeds.
  if (sorted.length !== classSet.size) {
    const missing = [...classSet].filter(c => !sorted.includes(c)).map(c => c.name);
    logger.warn(
      `Circular FK dependency between entities [${missing.join(" -> ")}] — ` +
        `flush order cannot be derived topologically. Falling back to registration order; ` +
        `if a FK constraint rejects this order, make one side of the cycle nullable ` +
        `or defer it out of the cycle.`,
    );
    return [...entityClasses];
  }

  // Duplicate input entries collapse via classSet — previously they made the
  // length check misreport a cycle. The result is the distinct class order.
  return sorted;
}

/**
 * Compute the topological sort once and return an index map for reuse.
 * Avoids redundant sorts when both sortForInsert and sortForDelete are needed.
 */
export function buildTopologicalIndexMap(
  registered: ClazzType<any>[],
): Map<ClazzType<any>, number> {
  const order = topologicalSort(registered);
  const indexMap = new Map<ClazzType<any>, number>();
  order.forEach((cls, i) => indexMap.set(cls, i));
  return indexMap;
}

/**
 * Sort entries by a pre-computed topological index map.
 * Avoids re-running topologicalSort() for each sort operation.
 */
export function sortByIndex<T extends { entity: ClazzType<any> }>(
  entries: T[],
  indexMap: Map<ClazzType<any>, number>,
  reverse = false,
): T[] {
  return [...entries].sort((a, b) => {
    const ai = indexMap.get(a.entity) ?? (reverse ? -1 : Number.MAX_SAFE_INTEGER);
    const bi = indexMap.get(b.entity) ?? (reverse ? -1 : Number.MAX_SAFE_INTEGER);
    return reverse ? bi - ai : ai - bi;
  });
}

/**
 * Sort entries for INSERT: parents first (topological order).
 */
export function sortForInsert<T extends { entity: ClazzType<any> }>(
  entries: T[],
  registered: ClazzType<any>[],
): T[] {
  const indexMap = buildTopologicalIndexMap(registered);
  return sortByIndex(entries, indexMap);
}

/**
 * Sort entries for DELETE: children first (reverse topological order).
 */
export function sortForDelete<T extends { entity: ClazzType<any> }>(
  entries: T[],
  registered: ClazzType<any>[],
): T[] {
  const indexMap = buildTopologicalIndexMap(registered);
  return sortByIndex(entries, indexMap, true);
}
