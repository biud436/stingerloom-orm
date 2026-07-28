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
  FkWriteKeys,
} from "./CollectionTracker";
import { IdentityMapManager, EntityInstance, ColumnValueMap } from "./IdentityMapManager";
import type { EntityManager } from "../../EntityManager";
import type { FlushEventType } from "./BufferPreview";

/**
 * Flush-time collaborators supplied by WriteBuffer after construction —
 * CascadeProcessor is built before FlushExecutor, so these arrive via
 * {@link CascadeProcessor.attachFlushHooks}. They let a cascade UPDATE of a
 * tracked child emit the same flush-event pair and @Version/@UpdateTimestamp
 * instance sync as the dirty-tracked flush pass.
 */
export interface CascadeFlushHooks {
  emitFlushEvent(
    type: FlushEventType,
    entity: ClazzType<any>,
    instance?: EntityInstance,
    data?: ColumnValueMap,
  ): Promise<void>;
  ensureVersionIncrement(
    entityClass: ClazzType<any>,
    instance: EntityInstance,
    snapshot: Record<string, any>,
  ): void;
  ensureTimestamps(
    entityClass: ClazzType<any>,
    instance: EntityInstance,
    isInsert: boolean,
  ): void;
}

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
 * Own-descriptor data read: returns the property value only when it is a
 * plain data property, so no accessor (e.g. a lazy-load getter) can fire.
 * Unlike {@link readLoadedRelationValue} this returns scalars — it exists for
 * FK shadow keys, which hold raw PK values.
 */
function readOwnDataValue(instance: any, propertyKey: string): any {
  if (instance === null || typeof instance !== "object") return undefined;
  const desc = Object.getOwnPropertyDescriptor(instance, propertyKey);
  if (!desc || !("value" in desc)) return undefined;
  return desc.value;
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
  private flushHooks?: CascadeFlushHooks;

  constructor(
    ctx: PluginContext,
    idMap: IdentityMapManager,
    options: ResolvedBufferOptions,
  ) {
    this.ctx = ctx;
    this.idMap = idMap;
    this.options = options;
  }

  /** Wire the flush-time collaborators (see {@link CascadeFlushHooks}). */
  attachFlushHooks(hooks: CascadeFlushHooks): void {
    this.flushHooks = hooks;
  }

  /**
   * Assign the parent PK to every FK write target of `child`, reporting
   * whether any target actually changed. The report matters for tracked
   * children whose FK is declared without a backing @Column (@RelationColumn
   * pattern): the shadow keys are not in columnNames, so the snapshot diff
   * alone cannot see a reparent — without this signal the write would be
   * skipped as "clean".
   */
  private assignFkDetectingChange(
    child: EntityInstance,
    keys: FkWriteKeys,
    parentPk: any,
  ): boolean {
    // Never READ keys.fkColumn here: its legacy fallback is the relation
    // property itself, where a read fires the lazy-load getter (a hidden
    // query mid-flush) and returns a Promise that would always compare as
    // "changed". Detection only needs the keys em.save actually resolves the
    // FK from — the shadow accessor and the explicit fkProperty — read via
    // own-descriptor so no getter can fire.
    const beforeShadow = readOwnDataValue(child, keys.shadowKey);
    const beforeProp =
      keys.fkPropertyKey !== undefined
        ? readOwnDataValue(child, keys.fkPropertyKey)
        : undefined;
    assignFkValue(child, keys, parentPk);
    return (
      beforeShadow !== parentPk ||
      (keys.fkPropertyKey !== undefined && beforeProp !== parentPk)
    );
  }

  /**
   * Save one cascade-reachable child with amplification guards:
   * - tracked + readOnly           → never written
   * - tracked + clean              → skipped entirely (no SQL, no events)
   * - tracked + dirty / FK changed → one UPDATE with a preUpdate/postUpdate
   *   flush-event pair, @Version/@UpdateTimestamp instance sync, and a
   *   snapshot re-baseline so the dirty-tracked flush pass does not write the
   *   same instance again
   * - untracked                    → saved as before (cascade merge
   *   semantics), counted as an INSERT or UPDATE mirroring em.save's own
   *   generated-PK decision
   */
  private async saveCascadeChild(
    txEm: EntityManager,
    ChildEntity: ClazzType<any>,
    child: EntityInstance,
    result: BufferFlushResult,
    fk?: { keys: FkWriteKeys; parentPk: any; changed: boolean },
  ): Promise<"skipped" | "updated" | "inserted"> {
    const entry = this.idMap.getTrackedEntry(child);
    if (entry) {
      if (entry.readOnly) return "skipped";
      const diff = this.idMap.diffTracked(entry);
      if (!diff && !fk?.changed) return "skipped";
      const eventDiff = diff ?? { [fk!.keys.fkColumn]: fk!.parentPk };
      await this.flushHooks?.emitFlushEvent("preUpdate", ChildEntity, child, eventDiff);
      const data = this.idMap.extractColumnData(child, entry.columnNames);
      if (fk) assignFkValue(data, fk.keys, fk.parentPk);
      const saved = await txEm.save(ChildEntity, data);
      if (saved) {
        for (const col of entry.columnNames) {
          const v = (saved as any)[col];
          if (v !== undefined) child[col] = v;
        }
      }
      this.flushHooks?.ensureVersionIncrement(ChildEntity, child, entry.snapshot);
      this.flushHooks?.ensureTimestamps(ChildEntity, child, false);
      this.idMap.rebaselineSnapshot(entry);
      result.updates++;
      await this.flushHooks?.emitFlushEvent("postUpdate", ChildEntity, child, eventDiff);
      return "updated";
    }

    const childInfo = this.idMap.getColumnInfo(ChildEntity);
    const hadFullPk =
      childInfo.pkColumns.length > 0 &&
      childInfo.pkColumns.every(
        (pk: string) => child[pk] !== undefined && child[pk] !== null,
      );
    const data: ColumnValueMap = {};
    for (const col of childInfo.columnNames) {
      if (child[col] !== undefined) data[col] = child[col];
    }
    if (fk) assignFkValue(data, fk.keys, fk.parentPk);
    const saved = await txEm.save(ChildEntity, data);
    if (saved) {
      for (const col of childInfo.columnNames) {
        const v = (saved as any)[col];
        if (v !== undefined) child[col] = v;
      }
    }
    // em.save UPDATEs only generated-PK entities whose PK is present;
    // everything else INSERTs (an assigned PK is present on new rows too).
    const wasUpdate = hadFullPk && this.idMap.hasGeneratedPk(ChildEntity);
    if (wasUpdate) result.updates++;
    else result.inserts++;
    return wasUpdate ? "updated" : "inserted";
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

        const childTracked = this.idMap.getTrackedEntry(child) !== undefined;
        const fkChanged = this.assignFkDetectingChange(child, fkKeys, parentPk);
        await this.saveCascadeChild(txEm, ChildEntity, child, result, {
          keys: fkKeys,
          parentPk,
          changed: fkChanged,
        });

        // A tracked child's M2M pivot rows are managed by the collection-diff
        // step — recursing with isNewParent=true re-INSERTed them on every
        // parent flush (a PK conflict on a keyed pivot). Untracked children
        // keep the legacy new-parent backfill.
        await this.processCascadeInsertUpdate(
          txEm, ChildEntity, child, visited, result, !childTracked,
        );
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
      const relatedTracked = this.idMap.getTrackedEntry(related) !== undefined;
      await this.saveCascadeChild(txEm, RelatedEntity, related, result);

      // If owning side, persist the FK on the parent row — but only when it
      // actually changed. The parent row was already written (INSERT on the
      // persist path / UPDATE on the dirty-tracked path) BEFORE this cascade
      // ran, so a freshly resolved PK needs a targeted UPDATE; an unchanged
      // FK re-wrote the parent row on every flush for nothing.
      if (rel.joinColumn) {
        const relatedPk = this.idMap.getParentPkValue(related, RelatedEntity);
        if (relatedPk != null && instance[rel.joinColumn] !== relatedPk) {
          instance[rel.joinColumn] = relatedPk;

          const parentInfo = this.idMap.getColumnInfo(entityClass);
          const parentPkValue = this.idMap.getParentPkValue(instance, entityClass);
          if (parentInfo.pkColumns.length === 1 && parentPkValue != null) {
            await txEm.update(
              entityClass,
              { [parentInfo.pkColumns[0]]: parentPkValue } as any,
              { [rel.joinColumn]: relatedPk } as any,
            );
          }
        }
      }

      await this.processCascadeInsertUpdate(
        txEm, RelatedEntity, related, visited, result, !relatedTracked,
      );
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
      const ChildEntity = snapshot.relatedEntity;
      for (const child of diff.added) {
        // A TRACKED child must not be skipped on `visited`: the dirty-tracked
        // pass may already have written its column edits, but the FK assigned
        // below is NEW information (a reparent) that still needs its own
        // UPDATE — skipping used to silently leave the row on its old parent.
        // The clean/dirty gate in saveCascadeChild keeps this idempotent.
        const tracked = this.idMap.getTrackedEntry(child) !== undefined;
        if (!tracked) {
          if (visited.has(child)) continue;
          visited.add(child);
        }

        const fkChanged = fkKeys
          ? this.assignFkDetectingChange(child, fkKeys, parentPk)
          : false;
        await this.saveCascadeChild(
          txEm, ChildEntity, child, result,
          fkKeys ? { keys: fkKeys, parentPk, changed: fkChanged } : undefined,
        );
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
