/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../../../decorators/OneToMany";
import { MANY_TO_MANY_TOKEN, ManyToManyMetadata } from "../../../decorators/ManyToMany";
import { MANY_TO_ONE_TOKEN } from "../../../decorators/ManyToOne";
import { RELATION_COLUMN_TOKEN, RelationColumnMetadata } from "../../../decorators/RelationColumn";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import { isLazyProxy } from "../../LazyLoader";

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
 * Read a relation property's LOADED value without ever triggering a lazy
 * load. Returns `undefined` for: an absent property, an accessor-based lazy
 * proxy (own get/set descriptor), an in-flight load Promise, a LazyLoader
 * proxy object, and scalar values (a legacy relation property holding a raw
 * FK is not a loaded relation).
 */
export function readLoadedRelationValue(instance: any, propertyKey: string): any {
  if (instance === null || typeof instance !== "object") return undefined;
  const desc = Object.getOwnPropertyDescriptor(instance, propertyKey);
  if (!desc || !("value" in desc)) return undefined;
  const val = desc.value;
  if (val === null || typeof val !== "object") return undefined;
  if (val instanceof Date) return undefined;
  if (typeof (val as { then?: unknown }).then === "function") return undefined;
  if (isLazyProxy(val)) return undefined;
  return val;
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
 * Resolve the child entity's foreign-key DB column name for a @OneToMany
 * relation, mirroring RelationMetadataResolver.resolveManyToOneMetadata so that
 * query paths (lazy load, cascade-delete criteria) target the real column.
 *
 * Resolution order for the inverse @ManyToOne (matched by `mappedBy`):
 *   1. @RelationColumn({ name }) → its name (or `${prop}Id` when omitted)
 *   2. deprecated @ManyToOne({ joinColumn }) option
 *   3. a backing @Column named `${prop}Id` → its DB name
 *   4. fallback: the relation property name (legacy column-name == property key)
 *
 * NOTE: this returns the DB column, suitable for WHERE/criteria. To WRITE the FK
 * on a cascade-inserted child (which goes through em.save, not a raw column),
 * use {@link resolveFkWriteKeys} — save reads the shadow accessor, not the raw
 * column.
 *
 * Exported for reuse by CascadeProcessor and LazyRelationInjector.
 */
export function resolveFkColumn(
  rel: OneToManyMetadata<any>,
  ChildEntity: ClazzType<any>,
): string {
  const mappedBy = rel.mappedBy;

  // 1. @RelationColumn wins (may declare an FK with no backing @Column).
  const relationColumns: RelationColumnMetadata[] =
    Reflect.getMetadata(RELATION_COLUMN_TOKEN, ChildEntity) ?? [];
  const relCol = relationColumns.find((rc) => rc.propertyKey === mappedBy);
  if (relCol) return relCol.name ?? `${mappedBy}Id`;

  // 2. Deprecated joinColumn option.
  const manyToOneMeta: any[] =
    Reflect.getMetadata(MANY_TO_ONE_TOKEN, ChildEntity) ?? [];
  const match = manyToOneMeta.find((m: any) => m.columnName === mappedBy);
  if (match?.joinColumn) return match.joinColumn;

  // 3. Backing @Column following the `${prop}Id` convention.
  // COLUMN_TOKEN lives on the PROTOTYPE (property decorator), unlike the
  // relation tokens which live on the constructor — reading it off the
  // constructor silently skipped this step and fell through to the legacy
  // property-name fallback, producing broken `WHERE "relationProp" = ?` SQL.
  const columnsMeta: any[] =
    Reflect.getMetadata(COLUMN_TOKEN, ChildEntity.prototype) ?? [];
  const fkProp = `${mappedBy}Id`;
  const colMatch = columnsMeta.find((c: any) => c.propertyKey === fkProp);
  if (colMatch) return colMatch.name ?? fkProp;

  // 4. Legacy fallback.
  return mappedBy;
}

/**
 * FK write targets for setting a cascade-inserted child's foreign key.
 *
 * em.save resolves a @ManyToOne FK from (in order) the relation object, the
 * shadow accessor `${prop}Id`, or an explicit `option.fkProperty` — never from
 * the raw join-column DB name. So a cascade insert must write the shadow (and
 * fkProperty), not just the raw column, or the FK is silently dropped when the
 * FK is declared via @RelationColumn with no backing @Column.
 * Mirrors CascadeHandler.cascadeSaveOneToMany.
 */
export interface FkWriteKeys {
  /** Legacy raw target: joinColumn option, else the relation property name. */
  fkColumn: string;
  /** Shadow accessor `${manyToOneProp}Id` — the key em.save actually reads. */
  shadowKey: string;
  /** Explicit @ManyToOne({ fkProperty }) backing property, when configured. */
  fkPropertyKey?: string;
}

/**
 * Resolve the FK write targets for the inverse @ManyToOne of a @OneToMany
 * relation (matched by `mappedBy`).
 */
export function resolveFkWriteKeys(
  mappedBy: string,
  ChildEntity: ClazzType<any>,
): FkWriteKeys {
  const manyToOneMeta: any[] =
    Reflect.getMetadata(MANY_TO_ONE_TOKEN, ChildEntity) ?? [];
  const match = manyToOneMeta.find((m: any) => m.columnName === mappedBy);
  return {
    fkColumn: match?.joinColumn ?? mappedBy,
    shadowKey: `${match?.columnName ?? mappedBy}Id`,
    fkPropertyKey: match?.option?.fkProperty,
  };
}

/**
 * Write a resolved parent PK to every FK target of a cascade-inserted child so
 * the FK survives em.save regardless of how it is declared.
 */
export function assignFkValue(
  target: any,
  keys: FkWriteKeys,
  value: any,
): void {
  target[keys.fkColumn] = value;
  target[keys.shadowKey] = value;
  if (keys.fkPropertyKey) target[keys.fkPropertyKey] = value;
}
