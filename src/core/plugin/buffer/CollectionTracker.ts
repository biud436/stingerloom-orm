/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../../../decorators/OneToMany";
import { MANY_TO_MANY_TOKEN, ManyToManyMetadata } from "../../../decorators/ManyToMany";
import { MANY_TO_ONE_TOKEN } from "../../../decorators/ManyToOne";

/**
 * Snapshot of a collection (O2M or M2M array) at track() time.
 */
export interface CollectionSnapshot {
  propertyKey: string;
  relationType: "oneToMany" | "manyToMany";
  originalItems: Set<any>;
  relatedEntity: ClazzType<any>;
  /** M2M only — join table info */
  joinTable?: { name: string; joinColumn: string; inverseJoinColumn: string };
  /** O2M only — FK column on child entity */
  fkColumn?: string;
  /** O2M mappedBy value */
  mappedBy?: string;
  /** O2M cascade options */
  cascade?: any;
}

/**
 * Diff between the current collection state and the snapshot.
 */
export interface CollectionDiff {
  added: any[];
  removed: any[];
  snapshot: CollectionSnapshot;
}

/**
 * Capture snapshots of all O2M and M2M (owning side) collections on an entity.
 */
export function snapshotCollections(
  instance: any,
  entityClass: ClazzType<any>,
): CollectionSnapshot[] {
  const snapshots: CollectionSnapshot[] = [];

  // OneToMany
  const o2mMeta: OneToManyMetadata<any>[] =
    Reflect.getMetadata(ONE_TO_MANY_TOKEN, entityClass) ?? [];
  for (const rel of o2mMeta) {
    const arr = instance[rel.propertyKey];
    if (!Array.isArray(arr)) continue;

    const ChildEntity = rel.getRelatedEntity();
    const fkColumn = resolveFkColumn(rel, ChildEntity);

    snapshots.push({
      propertyKey: rel.propertyKey,
      relationType: "oneToMany",
      originalItems: new Set(arr),
      relatedEntity: ChildEntity,
      fkColumn,
      mappedBy: rel.mappedBy,
      cascade: rel.cascade,
    });
  }

  // ManyToMany — owning side only (has joinTable, no mappedBy)
  const m2mMeta: ManyToManyMetadata<any>[] =
    Reflect.getMetadata(MANY_TO_MANY_TOKEN, entityClass) ?? [];
  for (const rel of m2mMeta) {
    if (rel.mappedBy || !rel.joinTable) continue; // skip inverse side

    const arr = instance[rel.propertyKey];
    if (!Array.isArray(arr)) continue;

    snapshots.push({
      propertyKey: rel.propertyKey,
      relationType: "manyToMany",
      originalItems: new Set(arr),
      relatedEntity: rel.getRelatedEntity(),
      joinTable: rel.joinTable,
    });
  }

  return snapshots;
}

/**
 * Diff current collection array vs snapshot. Returns null if unchanged.
 */
export function diffCollection(
  instance: any,
  snapshot: CollectionSnapshot,
): CollectionDiff | null {
  const currentArr = instance[snapshot.propertyKey];
  if (!Array.isArray(currentArr)) {
    // Collection removed entirely — treat all original items as removed
    if (snapshot.originalItems.size === 0) return null;
    return {
      added: [],
      removed: [...snapshot.originalItems],
      snapshot,
    };
  }

  const currentSet = new Set(currentArr);
  const added: any[] = [];
  const removed: any[] = [];

  for (const item of currentArr) {
    if (!snapshot.originalItems.has(item)) added.push(item);
  }

  for (const item of snapshot.originalItems) {
    if (!currentSet.has(item)) removed.push(item);
  }

  if (added.length === 0 && removed.length === 0) return null;

  return { added, removed, snapshot };
}

/**
 * Resolve the FK column name on the child entity for a given @OneToMany relation.
 * Exported for reuse by CascadeProcessor and LazyRelationInjector.
 */
export function resolveFkColumn(
  rel: OneToManyMetadata<any>,
  ChildEntity: ClazzType<any>,
): string {
  const manyToOneMeta: any[] =
    Reflect.getMetadata(MANY_TO_ONE_TOKEN, ChildEntity) ?? [];
  const match = manyToOneMeta.find(
    (m: any) => m.columnName === rel.mappedBy,
  );
  return match?.joinColumn ?? rel.mappedBy;
}
