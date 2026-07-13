/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../../../decorators/OneToMany";
import { ONE_TO_ONE_TOKEN } from "../../../decorators/OneToOne";
import { MANY_TO_MANY_TOKEN } from "../../../decorators/ManyToMany";
import { MANY_TO_ONE_TOKEN } from "../../../decorators/ManyToOne";
import { hasCascade } from "../../../types/CascadeType";
import { PluginContext } from "../PluginContext";
import { TrackedEntry, DeleteEntry } from "./BufferEntry";
import {
  BufferFlushResult,
  BufferPluginOptions,
  BufferPreviewEntry,
  ResolvedBufferOptions,
  buildSavePreviewEntry,
} from "./BufferPreview";
import { CollectionDiff } from "./CollectionTracker";
import {
  resolveFkColumn,
  resolveFkWriteKeys,
  assignFkValue,
  readLoadedRelationValue,
} from "./CollectionTracker";
import { IdentityMapManager, EntityInstance, ColumnValueMap } from "./IdentityMapManager";
import type { EntityManager } from "../../EntityManager";

/**
 * Children added to some tracked parent's O2M collection during a flush,
 * indexed by instance identity and by PK (per child entity name). Used to spare
 * reparented children from orphan removal — a child moved from parent A to
 * parent B appears in A.removed AND B.added, and must not be deleted.
 */
export interface ReparentedChildren {
  instances: Set<EntityInstance>;
  pks: Map<string, Set<any>>;
}

/**
 * Handles cascade insert/update/delete propagation for WriteBuffer.
 *
 * Walks @OneToMany, @OneToOne, and @ManyToMany relation metadata
 * to propagate persist/remove operations to related entities.
 */
export class CascadeProcessor {
  private readonly ctx: PluginContext;
  private readonly idMap: IdentityMapManager;
  private readonly options: ResolvedBufferOptions;

  constructor(
    ctx: PluginContext,
    idMap: IdentityMapManager,
    options: ResolvedBufferOptions,
  ) {
    this.ctx = ctx;
    this.idMap = idMap;
    this.options = options;
  }

  /**
   * Process cascade insert/update for @OneToMany, @OneToOne, and @ManyToMany relations.
   *
   * @param isNewParent — true when `instance` was just INSERTed (persist path).
   *   A new parent's collections have no snapshot baseline (it was never
   *   tracked), so the collection-diff flush step never writes its M2M pivot
   *   rows. When set, this method links every M2M child here instead. Cascade
   *   recursion always sets it (cascaded children are freshly saved).
   */
  async processCascadeInsertUpdate(
    txEm: EntityManager,
    entityClass: ClazzType<any>,
    instance: EntityInstance,
    visited: Set<EntityInstance>,
    result: BufferFlushResult,
    isNewParent = false,
  ): Promise<void> {
    if (!this.options.cascade.persist) return;

    // @OneToMany cascade
    const oneToManyMeta: OneToManyMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_MANY_TOKEN, entityClass) ?? [];

    for (const rel of oneToManyMeta) {
      if (!hasCascade(rel.cascade, "insert") && !hasCascade(rel.cascade, "update")) continue;

      const children = instance[rel.propertyKey];
      if (!Array.isArray(children) || children.length === 0) continue;

      const ChildEntity = rel.getRelatedEntity();
      const fkKeys = resolveFkWriteKeys(rel.mappedBy, ChildEntity);
      const parentPk = this.idMap.getParentPkValue(instance, entityClass);

      for (const child of children) {
        if (visited.has(child)) continue;
        visited.add(child);

        assignFkValue(child, fkKeys, parentPk);

        const childInfo = this.idMap.getColumnInfo(ChildEntity);
        const childData: ColumnValueMap = {};
        for (const col of childInfo.columnNames) {
          if (child[col] !== undefined) childData[col] = child[col];
        }
        assignFkValue(childData, fkKeys, parentPk);

        const savedChild = await txEm.save(ChildEntity, childData);
        if (savedChild) {
          for (const col of childInfo.columnNames) {
            const v = (savedChild as any)[col];
            if (v !== undefined) child[col] = v;
          }
        }
        result.inserts++;

        await this.processCascadeInsertUpdate(txEm, ChildEntity, child, visited, result, true);
      }
    }

    // @OneToOne cascade (owning side - has joinColumn)
    const oneToOneMeta: any[] =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ?? [];

    for (const rel of oneToOneMeta) {
      const cascade = rel.option?.cascade;
      if (!hasCascade(cascade, "insert") && !hasCascade(cascade, "update")) continue;

      const related = instance[rel.propertyKey];
      if (!related || visited.has(related)) continue;
      visited.add(related);

      const RelatedEntity = rel.getRelatedEntity();
      const relatedInfo = this.idMap.getColumnInfo(RelatedEntity);
      const relatedData: ColumnValueMap = {};
      for (const col of relatedInfo.columnNames) {
        if (related[col] !== undefined) relatedData[col] = related[col];
      }

      const saved = await txEm.save(RelatedEntity, relatedData);
      if (saved) {
        for (const col of relatedInfo.columnNames) {
          const v = (saved as any)[col];
          if (v !== undefined) related[col] = v;
        }
      }
      result.inserts++;

      // If owning side, set FK on parent
      if (rel.joinColumn) {
        const relatedPk = this.idMap.getParentPkValue(related, RelatedEntity);
        instance[rel.joinColumn] = relatedPk;

        // The parent row was already written (INSERT on the persist path /
        // UPDATE on the dirty-tracked path) BEFORE this cascade ran, with the
        // FK still null or stale — the related entity did not have a PK yet.
        // Persist the now-resolved FK to the parent row with a targeted UPDATE
        // so it is not silently lost.
        const parentInfo = this.idMap.getColumnInfo(entityClass);
        const parentPkValue = this.idMap.getParentPkValue(instance, entityClass);
        if (
          parentInfo.pkColumns.length === 1 &&
          parentPkValue != null &&
          relatedPk != null
        ) {
          await txEm.update(
            entityClass,
            { [parentInfo.pkColumns[0]]: parentPkValue } as any,
            { [rel.joinColumn]: relatedPk } as any,
          );
        }
      }

      await this.processCascadeInsertUpdate(txEm, RelatedEntity, related, visited, result, true);
    }

    // @ManyToMany cascade persist (owning side - has joinTable, no mappedBy)
    const manyToManyMeta: any[] =
      Reflect.getMetadata(MANY_TO_MANY_TOKEN, entityClass) ?? [];

    for (const rel of manyToManyMeta) {
      if (rel.mappedBy || !rel.joinTable) continue; // skip inverse side

      const children = instance[rel.propertyKey];
      if (!Array.isArray(children) || children.length === 0) continue;

      const RelatedEntity = rel.getRelatedEntity();
      const relatedPkColumns = this.idMap.getColumnInfo(RelatedEntity).pkColumns;

      for (const child of children) {
        // Only cascade-persist NEW children (no PK)
        const hasPk = relatedPkColumns.every((pk: string) => {
          const v = child[pk];
          return v !== undefined && v !== null;
        });

        if (!hasPk && !visited.has(child)) {
          visited.add(child);
          const childInfo = this.idMap.getColumnInfo(RelatedEntity);
          const childData: ColumnValueMap = {};
          for (const col of childInfo.columnNames) {
            if (child[col] !== undefined) childData[col] = child[col];
          }

          const saved = await txEm.save(RelatedEntity, childData);
          if (saved) {
            for (const col of childInfo.columnNames) {
              const v = (saved as any)[col];
              if (v !== undefined) child[col] = v;
            }
          }
          result.inserts++;
        }
      }

      // A NEW parent's collection has no snapshot baseline (it was never
      // tracked), so the collection-diff flush step never writes its pivot
      // rows. Link every child here — all of them are "added" relative to an
      // empty original set. Existing (tracked) parents are handled by
      // processManyToManyCollectionDiff instead, so skip them to avoid
      // double-inserting.
      if (isNewParent && this.options.manyToManySync && rel.joinTable) {
        const parentPk = this.idMap.getParentPkValue(instance, entityClass);
        if (parentPk != null && relatedPkColumns.length === 1) {
          for (const child of children) {
            const childPk = child[relatedPkColumns[0]];
            if (childPk == null) continue;
            await this.insertPivotRow(txEm, rel.joinTable, parentPk, childPk);
            result.inserts++;
          }
        }
      }
    }
  }

  /**
   * Insert a single M2M pivot (join table) row linking a parent PK to a child PK.
   */
  private async insertPivotRow(
    txEm: EntityManager,
    joinTable: { name: string; joinColumn: string; inverseJoinColumn: string },
    parentPk: any,
    childPk: any,
  ): Promise<void> {
    const wrappedTable = this.ctx.wrapTable(joinTable.name);
    const wrappedJoinCol = this.ctx.wrap(joinTable.joinColumn);
    const wrappedInverseCol = this.ctx.wrap(joinTable.inverseJoinColumn);
    const sql = `INSERT INTO ${wrappedTable} (${wrappedJoinCol}, ${wrappedInverseCol}) VALUES (?, ?)`;
    await txEm.query(sql, [parentPk, childPk]);
  }

  /**
   * Process O2M collection diffs: cascade insert added items, orphan-remove removed items.
   */
  async processOneToManyCollectionDiff(
    txEm: EntityManager,
    parentEntry: TrackedEntry,
    diff: CollectionDiff,
    visited: Set<EntityInstance>,
    result: BufferFlushResult,
    reparented?: ReparentedChildren,
  ): Promise<void> {
    const { snapshot } = diff;
    const parentPk = this.idMap.getParentPkValue(parentEntry.instance, parentEntry.entity);

    // Added children - cascade insert if cascade includes insert
    if (this.options.cascade.persist && hasCascade(snapshot.cascade, "insert")) {
      const fkKeys = snapshot.mappedBy
        ? resolveFkWriteKeys(snapshot.mappedBy, snapshot.relatedEntity)
        : undefined;
      for (const child of diff.added) {
        if (visited.has(child)) continue;
        visited.add(child);

        if (fkKeys) assignFkValue(child, fkKeys, parentPk);

        const ChildEntity = snapshot.relatedEntity;
        const childInfo = this.idMap.getColumnInfo(ChildEntity);
        const childData: ColumnValueMap = {};
        for (const col of childInfo.columnNames) {
          if (child[col] !== undefined) childData[col] = child[col];
        }
        if (fkKeys) assignFkValue(childData, fkKeys, parentPk);

        const saved = await txEm.save(ChildEntity, childData);
        if (saved) {
          for (const col of childInfo.columnNames) {
            const v = (saved as any)[col];
            if (v !== undefined) child[col] = v;
          }
        }
        result.inserts++;
      }
    }

    // Removed children - orphan removal if enabled
    if (this.options.orphanRemoval) {
      const ChildEntity = snapshot.relatedEntity;
      const childInfo = this.idMap.getColumnInfo(ChildEntity);
      const reparentedPks = reparented?.pks.get(ChildEntity.name);
      for (const child of diff.removed) {
        // A child re-added to another tracked parent was reparented, not
        // orphaned — deleting it would destroy a row that still has an owner.
        if (reparented?.instances.has(child)) continue;

        const criteria: ColumnValueMap = {};
        for (const pk of childInfo.pkColumns) {
          const v = child[pk];
          if (v !== undefined && v !== null) criteria[pk] = v;
        }
        if (Object.keys(criteria).length === 0) continue;

        // Same row moved as a fresh instance (reloaded) — match by PK too.
        if (
          reparentedPks &&
          childInfo.pkColumns.length === 1 &&
          reparentedPks.has(criteria[childInfo.pkColumns[0]])
        ) {
          continue;
        }

        await txEm.delete(ChildEntity, criteria);
        result.deletes++;
      }
    }
  }

  /**
   * Process M2M collection diffs: insert/delete pivot table rows.
   */
  async processManyToManyCollectionDiff(
    txEm: EntityManager,
    parentEntry: TrackedEntry,
    diff: CollectionDiff,
    result: BufferFlushResult,
  ): Promise<void> {
    if (!this.options.manyToManySync) return;

    const { snapshot } = diff;
    if (!snapshot.joinTable) return;

    const { name: tableName, joinColumn, inverseJoinColumn } = snapshot.joinTable;
    const parentPk = this.idMap.getParentPkValue(parentEntry.instance, parentEntry.entity);
    const childPkColumns = this.idMap.getColumnInfo(snapshot.relatedEntity).pkColumns;

    const wrappedTable = this.ctx.wrapTable(tableName);
    const wrappedJoinCol = this.ctx.wrap(joinColumn);
    const wrappedInverseCol = this.ctx.wrap(inverseJoinColumn);

    // Added items -> INSERT into pivot table
    for (const child of diff.added) {
      const childPk = childPkColumns.length === 1 ? child[childPkColumns[0]] : null;
      if (childPk == null) continue;
      await this.insertPivotRow(txEm, snapshot.joinTable, parentPk, childPk);
      result.inserts++;
    }

    // Removed items -> DELETE from pivot table
    for (const child of diff.removed) {
      const childPk = childPkColumns.length === 1 ? child[childPkColumns[0]] : null;
      if (childPk == null) continue;
      const sql = `DELETE FROM ${wrappedTable} WHERE ${wrappedJoinCol} = ? AND ${wrappedInverseCol} = ?`;
      await txEm.query(sql, [parentPk, childPk]);
      result.deletes++;
    }
  }

  /**
   * Enumerate — WITHOUT touching the database or mutating any instance — the
   * cascade-persist operations {@link processCascadeInsertUpdate} will execute
   * for a newly persisted instance: O2M children (FK included when the parent
   * PK is already known), a cascaded O2O related entity, new (PK-less) M2M
   * children, and M2M pivot rows. Mirrors that method's traversal and gating;
   * used by `WriteBuffer.preview()`.
   *
   * Known preview gaps (values only resolvable at flush time):
   * - DB-generated PKs are unknown, so FK / pivot values derived from them
   *   are omitted from the entry data (the operations are still listed).
   * - The owning-side O2O FK fix-up UPDATE on the parent row is not listed.
   */
  collectCascadePreviewInserts(
    entityClass: ClazzType<any>,
    instance: EntityInstance,
    visited: Set<EntityInstance>,
    entries: BufferPreviewEntry[],
  ): void {
    if (!this.options.cascade.persist) return;

    // @OneToMany cascade
    const oneToManyMeta: OneToManyMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_MANY_TOKEN, entityClass) ?? [];
    for (const rel of oneToManyMeta) {
      if (!hasCascade(rel.cascade, "insert") && !hasCascade(rel.cascade, "update")) continue;
      const children = readLoadedRelationValue(instance, rel.propertyKey);
      if (!Array.isArray(children) || children.length === 0) continue;

      const ChildEntity = rel.getRelatedEntity();
      const fkKeys = resolveFkWriteKeys(rel.mappedBy, ChildEntity);
      const parentPk = this.idMap.getParentPkValue(instance, entityClass);
      const childInfo = this.idMap.getColumnInfo(ChildEntity);

      for (const child of children) {
        if (visited.has(child)) continue;
        visited.add(child);
        const childData: ColumnValueMap = {};
        for (const col of childInfo.columnNames) {
          if (child[col] !== undefined) childData[col] = child[col];
        }
        if (parentPk != null) assignFkValue(childData, fkKeys, parentPk);
        entries.push(buildSavePreviewEntry(ChildEntity.name, childData, childInfo.pkColumns));
        this.collectCascadePreviewInserts(ChildEntity, child, visited, entries);
      }
    }

    // @OneToOne cascade (owning side)
    const oneToOneMeta: any[] =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ?? [];
    for (const rel of oneToOneMeta) {
      const cascade = rel.option?.cascade;
      if (!hasCascade(cascade, "insert") && !hasCascade(cascade, "update")) continue;
      const related = readLoadedRelationValue(instance, rel.propertyKey);
      if (!related || Array.isArray(related) || visited.has(related)) continue;
      visited.add(related);

      const RelatedEntity = rel.getRelatedEntity();
      const relatedInfo = this.idMap.getColumnInfo(RelatedEntity);
      const relatedData: ColumnValueMap = {};
      for (const col of relatedInfo.columnNames) {
        if (related[col] !== undefined) relatedData[col] = related[col];
      }
      entries.push(buildSavePreviewEntry(RelatedEntity.name, relatedData, relatedInfo.pkColumns));
      this.collectCascadePreviewInserts(RelatedEntity, related, visited, entries);
    }

    // @ManyToMany cascade persist + pivot rows (owning side)
    const manyToManyMeta: any[] =
      Reflect.getMetadata(MANY_TO_MANY_TOKEN, entityClass) ?? [];
    for (const rel of manyToManyMeta) {
      if (rel.mappedBy || !rel.joinTable) continue;
      const children = readLoadedRelationValue(instance, rel.propertyKey);
      if (!Array.isArray(children) || children.length === 0) continue;

      const RelatedEntity = rel.getRelatedEntity();
      const relatedInfo = this.idMap.getColumnInfo(RelatedEntity);
      const relatedPkColumns = relatedInfo.pkColumns;
      const parentPk = this.idMap.getParentPkValue(instance, entityClass);

      for (const child of children) {
        const hasPk = relatedPkColumns.every((pk: string) => {
          const v = child[pk];
          return v !== undefined && v !== null;
        });
        if (!hasPk && !visited.has(child)) {
          visited.add(child);
          const childData: ColumnValueMap = {};
          for (const col of relatedInfo.columnNames) {
            if (child[col] !== undefined) childData[col] = child[col];
          }
          entries.push({ action: "insert", entity: RelatedEntity.name, data: childData });
        }
      }

      // Every child of a NEW parent gets a pivot row on flush (all have PKs
      // by then — cascade persist just assigned them). List one pivot INSERT
      // per child, carrying whichever PK values are already known.
      if (this.options.manyToManySync && relatedPkColumns.length === 1) {
        for (const child of children) {
          const data: ColumnValueMap = {};
          if (parentPk != null) data[rel.joinTable.joinColumn] = parentPk;
          const childPk = child[relatedPkColumns[0]];
          if (childPk != null) data[rel.joinTable.inverseJoinColumn] = childPk;
          entries.push({ action: "insert", entity: rel.joinTable.name, data });
        }
      }
    }
  }

  /**
   * Collect cascade delete entries by walking O2M and O2O relations
   * that have cascade: "delete" or cascade: true.
   *
   * Only swallows "not a registered entity" / "table not found" errors;
   * re-throws all others.
   */
  async collectCascadeDeletes(
    txEm: EntityManager,
    entityClass: ClazzType<any>,
    criteria: ColumnValueMap,
    out: DeleteEntry[],
    visited: Set<string>,
  ): Promise<void> {
    const key = `${entityClass.name}:${JSON.stringify(criteria)}`;
    if (visited.has(key)) return;
    visited.add(key);

    // O2M cascade delete
    const o2mMeta: OneToManyMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_MANY_TOKEN, entityClass) ?? [];

    for (const rel of o2mMeta) {
      if (!hasCascade(rel.cascade, "delete")) continue;

      const ChildEntity = rel.getRelatedEntity();
      const fkColumn = resolveFkColumn(rel, ChildEntity);
      const { pkColumns: parentPks } = this.idMap.getColumnInfo(entityClass);
      if (parentPks.length === 0) continue;

      // The child FK references a single parent column: the inverse
      // @ManyToOne's `references` option when set, else the parent's FIRST PK
      // column (mirroring core CascadeHandler.cascadeDeleteOneToMany). A
      // composite-PK parent cascades through that referenced column — it was
      // previously skipped outright (`parentPks.length === 1` gate), leaving
      // child rows and stale identity-map entries behind.
      const m2oMeta: any[] =
        Reflect.getMetadata(MANY_TO_ONE_TOKEN, ChildEntity) ?? [];
      const inverse = m2oMeta.find((m: any) => m.columnName === rel.mappedBy);
      const referencedCol = inverse?.references ?? parentPks[0];

      // Build child criteria from the referenced parent column value
      const childCriteria: ColumnValueMap = {};
      if (criteria[referencedCol] != null) {
        childCriteria[fkColumn] = criteria[referencedCol];
      }

      if (Object.keys(childCriteria).length > 0 && childCriteria[fkColumn] != null) {
        // Recurse into child's children first
        const childPkCols = this.idMap.getColumnInfo(ChildEntity).pkColumns;
        try {
          const children = await txEm.find(ChildEntity, { where: childCriteria as any });
          for (const child of children) {
            const grandChildCriteria: ColumnValueMap = {};
            for (const pk of childPkCols) grandChildCriteria[pk] = (child as any)[pk];
            await this.collectCascadeDeletes(txEm, ChildEntity, grandChildCriteria, out, visited);
          }
        } catch (err) {
          // Only swallow "not registered" / "table not found" errors — re-throw others
          if (err instanceof Error && /not.*registered|no.*entity|table.*not/i.test(err.message)) {
            // skip recursive cascade for unregistered entities
          } else {
            throw err;
          }
        }

        out.push({ entity: ChildEntity, criteria: childCriteria });
      }
    }

    // O2O cascade delete (owning side - has joinColumn)
    const o2oMeta: any[] =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ?? [];

    for (const rel of o2oMeta) {
      if (!hasCascade(rel.option?.cascade, "delete")) continue;

      const RelatedEntity = rel.getRelatedEntity();
      const relatedPkCols = this.idMap.getColumnInfo(RelatedEntity).pkColumns;

      // If we have the FK value, build criteria for the related entity
      if (rel.joinColumn && criteria[rel.joinColumn] != null) {
        const relCriteria: ColumnValueMap = {};
        if (relatedPkCols.length === 1) {
          relCriteria[relatedPkCols[0]] = criteria[rel.joinColumn];
        }
        if (Object.keys(relCriteria).length > 0) {
          await this.collectCascadeDeletes(txEm, RelatedEntity, relCriteria, out, visited);
          out.push({ entity: RelatedEntity, criteria: relCriteria });
        }
      }
    }
  }

  /**
   * Invoke `cb` for every related instance reachable through LOADED relation
   * values — the same relations the cascade write paths mutate (O2M, O2O,
   * M2M owning side). Unlike {@link propagateToRelations}, unloaded lazy
   * proxies and in-flight loads are skipped and never triggered, so this is
   * safe to run outside a query context. Used to widen the pre-flush rollback
   * snapshot to cascade-reachable children.
   */
  forEachLoadedRelated(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
    cb: (child: EntityInstance) => void,
  ): void {
    const o2mMeta: OneToManyMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_MANY_TOKEN, entityClass) ?? [];
    for (const rel of o2mMeta) {
      const children = readLoadedRelationValue(instance, rel.propertyKey);
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        if (child !== null && typeof child === "object") cb(child);
      }
    }

    const o2oMeta: any[] =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ?? [];
    for (const rel of o2oMeta) {
      const related = readLoadedRelationValue(instance, rel.propertyKey);
      if (related !== undefined && !Array.isArray(related)) cb(related);
    }

    const m2mMeta: any[] =
      Reflect.getMetadata(MANY_TO_MANY_TOKEN, entityClass) ?? [];
    for (const rel of m2mMeta) {
      if (rel.mappedBy || !rel.joinTable) continue;
      const children = readLoadedRelationValue(instance, rel.propertyKey);
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        if (child !== null && typeof child === "object") cb(child);
      }
    }
  }

  /**
   * Propagate an operation to all related entities (O2M, O2O, M2M owning side).
   * Used for cascade detach/merge.
   */
  propagateToRelations(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
    callback: (child: EntityInstance) => void,
  ): void {
    // O2M
    const o2mMeta: OneToManyMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_MANY_TOKEN, entityClass) ?? [];
    for (const rel of o2mMeta) {
      const children = instance[rel.propertyKey];
      if (Array.isArray(children)) {
        for (const child of children) callback(child);
      }
    }

    // O2O
    const o2oMeta: any[] =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ?? [];
    for (const rel of o2oMeta) {
      const related = instance[rel.propertyKey];
      if (related) callback(related);
    }

    // M2M owning side
    const m2mMeta: any[] =
      Reflect.getMetadata(MANY_TO_MANY_TOKEN, entityClass) ?? [];
    for (const rel of m2mMeta) {
      if (rel.mappedBy || !rel.joinTable) continue;
      const children = instance[rel.propertyKey];
      if (Array.isArray(children)) {
        for (const child of children) callback(child);
      }
    }
  }

  /**
   * Get tracked related entities for cascade refresh.
   * Only returns entities that are already tracked in the given trackedEntries map.
   */
  getTrackedRelatedEntities(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
    trackedEntries: Map<EntityInstance, TrackedEntry>,
  ): EntityInstance[] {
    const related: EntityInstance[] = [];

    this.propagateToRelations(instance, entityClass, (child) => {
      if (trackedEntries.has(child)) {
        related.push(child);
      }
    });

    return related;
  }
}
