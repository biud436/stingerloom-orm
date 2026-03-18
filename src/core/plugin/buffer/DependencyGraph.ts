/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { MANY_TO_ONE_TOKEN } from "../../../decorators/ManyToOne";
import { ONE_TO_ONE_TOKEN } from "../../../decorators/OneToOne";

/**
 * Build a dependency graph from @ManyToOne and @OneToOne(joinColumn) metadata.
 * A child "depends on" its parent (the entity it references via FK).
 *
 * Returns entities in topological order (parents first) using Kahn's algorithm.
 * On cycle detection, falls back to the original order (safe default).
 */
export function topologicalSort(entityClasses: ClazzType<any>[]): ClazzType<any>[] {
  if (entityClasses.length <= 1) return [...entityClasses];

  const classSet = new Set(entityClasses);
  // adjacency: Map<entity, Set<entities it depends on>>
  const deps = new Map<ClazzType<any>, Set<ClazzType<any>>>();
  // reverse adjacency for in-degree tracking
  const dependents = new Map<ClazzType<any>, Set<ClazzType<any>>>();

  for (const cls of entityClasses) {
    deps.set(cls, new Set());
    dependents.set(cls, new Set());
  }

  for (const cls of entityClasses) {
    // @ManyToOne → cls depends on parent
    const m2oMeta: any[] = Reflect.getMetadata(MANY_TO_ONE_TOKEN, cls) ?? [];
    for (const m of m2oMeta) {
      const parent = typeof m.getMappingEntity === "function" ? m.getMappingEntity() : m.type;
      if (parent && classSet.has(parent) && parent !== cls) {
        deps.get(cls)!.add(parent);
        dependents.get(parent)!.add(cls);
      }
    }

    // @OneToOne(joinColumn) → owning side depends on target
    const o2oMeta: any[] = Reflect.getMetadata(ONE_TO_ONE_TOKEN, cls) ?? [];
    for (const m of o2oMeta) {
      if (m.joinColumn) {
        const target = typeof m.getRelatedEntity === "function" ? m.getRelatedEntity() : null;
        if (target && classSet.has(target) && target !== cls) {
          deps.get(cls)!.add(target);
          dependents.get(target)!.add(cls);
        }
      }
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<ClazzType<any>, number>();
  for (const cls of entityClasses) {
    inDegree.set(cls, deps.get(cls)!.size);
  }

  const queue: ClazzType<any>[] = [];
  for (const cls of entityClasses) {
    if (inDegree.get(cls) === 0) queue.push(cls);
  }

  const sorted: ClazzType<any>[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const dep of dependents.get(node)!) {
      const newDeg = inDegree.get(dep)! - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  // Cycle detected — fallback to original order
  if (sorted.length !== entityClasses.length) {
    return [...entityClasses];
  }

  return sorted;
}

/**
 * Sort entries for INSERT: parents first (topological order).
 */
export function sortForInsert<T extends { entity: ClazzType<any> }>(
  entries: T[],
  registered: ClazzType<any>[],
): T[] {
  const order = topologicalSort(registered);
  const indexMap = new Map<ClazzType<any>, number>();
  order.forEach((cls, i) => indexMap.set(cls, i));

  return [...entries].sort((a, b) => {
    const ai = indexMap.get(a.entity) ?? Number.MAX_SAFE_INTEGER;
    const bi = indexMap.get(b.entity) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

/**
 * Sort entries for DELETE: children first (reverse topological order).
 */
export function sortForDelete<T extends { entity: ClazzType<any> }>(
  entries: T[],
  registered: ClazzType<any>[],
): T[] {
  const order = topologicalSort(registered);
  const indexMap = new Map<ClazzType<any>, number>();
  order.forEach((cls, i) => indexMap.set(cls, i));

  return [...entries].sort((a, b) => {
    const ai = indexMap.get(a.entity) ?? -1;
    const bi = indexMap.get(b.entity) ?? -1;
    return bi - ai; // reverse
  });
}
