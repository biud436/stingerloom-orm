/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../../../decorators/OneToMany";
import { ONE_TO_ONE_TOKEN } from "../../../decorators/OneToOne";
import { MANY_TO_MANY_TOKEN } from "../../../decorators/ManyToMany";
import { hasCascade } from "../../../types/CascadeType";
import { PluginContext } from "../PluginContext";
import { TrackedEntry, DeleteEntry } from "./BufferEntry";
import { BufferFlushResult, BufferPluginOptions, ResolvedBufferOptions } from "./BufferPreview";
import { CollectionDiff } from "./CollectionTracker";
import { resolveFkColumn } from "./CollectionTracker";
import { IdentityMapManager, EntityInstance, ColumnValueMap } from "./IdentityMapManager";
import type { EntityManager } from "../../EntityManager";

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
   */
  async processCascadeInsertUpdate(
    txEm: EntityManager,
    entityClass: ClazzType<any>,
    instance: EntityInstance,
    visited: Set<EntityInstance>,
    result: BufferFlushResult,
  ): Promise<void> {
    if (!this.options.cascade) return;

    // @OneToMany cascade
    const oneToManyMeta: OneToManyMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_MANY_TOKEN, entityClass) ?? [];

    for (const rel of oneToManyMeta) {
      if (!hasCascade(rel.cascade, "insert") && !hasCascade(rel.cascade, "update")) continue;

      const children = instance[rel.propertyKey];
      if (!Array.isArray(children) || children.length === 0) continue;

      const ChildEntity = rel.getRelatedEntity();
      const fkColumn = resolveFkColumn(rel, ChildEntity);
      const parentPk = this.idMap.getParentPkValue(instance, entityClass);

      for (const child of children) {
        if (visited.has(child)) continue;
        visited.add(child);

        child[fkColumn] = parentPk;

        const childInfo = this.idMap.getColumnInfo(ChildEntity);
        const childData: ColumnValueMap = {};
        for (const col of childInfo.columnNames) {
          if (child[col] !== undefined) childData[col] = child[col];
        }
        childData[fkColumn] = parentPk;

        const savedChild = await txEm.save(ChildEntity, childData);
        if (savedChild) {
          for (const col of childInfo.columnNames) {
            const v = (savedChild as any)[col];
            if (v !== undefined) child[col] = v;
          }
        }
        result.inserts++;

        await this.processCascadeInsertUpdate(txEm, ChildEntity, child, visited, result);
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
      }

      await this.processCascadeInsertUpdate(txEm, RelatedEntity, related, visited, result);
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
    }
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
  ): Promise<void> {
    const { snapshot } = diff;
    const parentPk = this.idMap.getParentPkValue(parentEntry.instance, parentEntry.entity);

    // Added children - cascade insert if cascade includes insert
    if (this.options.cascade && hasCascade(snapshot.cascade, "insert")) {
      for (const child of diff.added) {
        if (visited.has(child)) continue;
        visited.add(child);

        if (snapshot.fkColumn) {
          child[snapshot.fkColumn] = parentPk;
        }

        const ChildEntity = snapshot.relatedEntity;
        const childInfo = this.idMap.getColumnInfo(ChildEntity);
        const childData: ColumnValueMap = {};
        for (const col of childInfo.columnNames) {
          if (child[col] !== undefined) childData[col] = child[col];
        }
        if (snapshot.fkColumn) {
          childData[snapshot.fkColumn] = parentPk;
        }

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
      for (const child of diff.removed) {
        const criteria: ColumnValueMap = {};
        for (const pk of childInfo.pkColumns) {
          const v = child[pk];
          if (v !== undefined && v !== null) criteria[pk] = v;
        }
        if (Object.keys(criteria).length > 0) {
          await txEm.delete(ChildEntity, criteria);
          result.deletes++;
        }
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
      const sql = `INSERT INTO ${wrappedTable} (${wrappedJoinCol}, ${wrappedInverseCol}) VALUES (?, ?)`;
      await txEm.query(sql, [parentPk, childPk]);
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

      // Build child criteria from parent PK
      const childCriteria: ColumnValueMap = {};
      if (parentPks.length === 1) {
        childCriteria[fkColumn] = criteria[parentPks[0]];
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
