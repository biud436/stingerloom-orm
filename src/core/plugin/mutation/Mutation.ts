/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import { ColumnMetadata } from "../../../scanner/ColumnScanner";
import { PluginContext } from "../PluginContext";
import { TrackedEntry, InsertEntry, DeleteEntry } from "./MutationEntry";
import { MutationPreviewEntry, MutationFlushResult, MutationPluginOptions } from "./MutationPreview";
import { MutationStrategy, SnapshotStrategy } from "./MutationStrategy";

/**
 * Mutation — tracks entity changes and provides batch flush.
 *
 * Created via `em.mutate()` after installing the mutation plugin.
 */
export class Mutation {
  private readonly trackedEntries = new Map<any, TrackedEntry>();
  private readonly insertQueue: InsertEntry[] = [];
  private readonly deleteQueue: DeleteEntry[] = [];
  private readonly strategy: MutationStrategy;
  private readonly ctx: PluginContext;
  private readonly options: Required<MutationPluginOptions>;

  constructor(
    ctx: PluginContext,
    options: MutationPluginOptions = {},
  ) {
    this.ctx = ctx;
    this.strategy = new SnapshotStrategy();
    this.options = {
      retainAfterFlush: options.retainAfterFlush ?? true,
    };
  }

  /**
   * Track an existing entity instance for dirty checking.
   * Takes a snapshot of the current column values.
   */
  track(instance: any): this {
    if (this.trackedEntries.has(instance)) {
      return this; // idempotent
    }

    const entityClass = instance.constructor as ClazzType<any>;
    this.validateEntity(entityClass);

    const { columnNames, pkColumns } = this.getColumnInfo(entityClass);
    const snapshot = this.strategy.snapshot(instance, columnNames);

    this.trackedEntries.set(instance, {
      entity: entityClass,
      instance,
      snapshot,
      columnNames,
      pkColumns,
    });

    return this;
  }

  /**
   * Queue an INSERT operation.
   */
  save(entityClass: ClazzType<any>, data: Record<string, any>): this {
    this.insertQueue.push({ entity: entityClass, data });
    return this;
  }

  /**
   * Queue a DELETE operation.
   */
  delete(entityClass: ClazzType<any>, criteria: Record<string, any>): this {
    this.deleteQueue.push({ entity: entityClass, criteria });
    return this;
  }

  /**
   * Returns all tracked entity instances.
   */
  tracked(): any[] {
    return [...this.trackedEntries.values()].map((e) => e.instance);
  }

  /**
   * Returns tracked entities that have changed since their snapshot.
   */
  dirty(): any[] {
    const result: any[] = [];
    for (const entry of this.trackedEntries.values()) {
      const diff = this.strategy.diff(
        entry.instance,
        entry.snapshot,
        entry.columnNames,
        entry.pkColumns,
      );
      if (diff) {
        result.push(entry.instance);
      }
    }
    return result;
  }

  /**
   * Remove a specific entity from tracking.
   */
  untrack(instance: any): this {
    this.trackedEntries.delete(instance);
    return this;
  }

  /**
   * Clear all tracked entities and queued operations.
   */
  clear(): this {
    this.trackedEntries.clear();
    this.insertQueue.length = 0;
    this.deleteQueue.length = 0;
    return this;
  }

  /**
   * Returns the total count of tracked + queued operations.
   */
  size(): { tracked: number; inserts: number; deletes: number } {
    return {
      tracked: this.trackedEntries.size,
      inserts: this.insertQueue.length,
      deletes: this.deleteQueue.length,
    };
  }

  /**
   * Preview the operations that will be executed on flush, in execution order.
   * Order: updates → inserts → deletes.
   */
  preview(): MutationPreviewEntry[] {
    const entries: MutationPreviewEntry[] = [];

    // Updates (dirty tracked entities)
    for (const entry of this.trackedEntries.values()) {
      const diff = this.strategy.diff(
        entry.instance,
        entry.snapshot,
        entry.columnNames,
        entry.pkColumns,
      );
      if (diff) {
        entries.push({
          action: "update",
          entity: entry.entity.name,
          where: this.buildPkWhere(entry),
          data: diff,
        });
      }
    }

    // Inserts
    for (const insert of this.insertQueue) {
      entries.push({
        action: "insert",
        entity: insert.entity.name,
        data: insert.data,
      });
    }

    // Deletes
    for (const del of this.deleteQueue) {
      entries.push({
        action: "delete",
        entity: del.entity.name,
        criteria: del.criteria,
      });
    }

    return entries;
  }

  /**
   * Execute all pending operations atomically within a transaction.
   * Order: updates → inserts → deletes.
   */
  async flush(): Promise<MutationFlushResult> {
    const preview = this.preview();

    // No-op if nothing to do
    if (preview.length === 0) {
      return { updates: 0, inserts: 0, deletes: 0 };
    }

    const em = this.ctx.em;
    const result: MutationFlushResult = { updates: 0, inserts: 0, deletes: 0 };

    // Capture queues before flush (for retry on failure)
    const insertsCopy = [...this.insertQueue];
    const deletesCopy = [...this.deleteQueue];

    try {
      await em.transaction(async (txEm) => {
        // 1. Updates — dirty tracked entities
        for (const entry of this.trackedEntries.values()) {
          const diff = this.strategy.diff(
            entry.instance,
            entry.snapshot,
            entry.columnNames,
            entry.pkColumns,
          );
          if (diff) {
            const where = this.buildPkWhere(entry);
            await txEm.updateMany(entry.entity, diff, { where });
            result.updates++;
          }
        }

        // 2. Inserts
        for (const insert of insertsCopy) {
          await txEm.save(insert.entity, insert.data);
          result.inserts++;
        }

        // 3. Deletes
        for (const del of deletesCopy) {
          await txEm.delete(del.entity, del.criteria);
          result.deletes++;
        }
      });

      // Success — clear queues
      this.insertQueue.length = 0;
      this.deleteQueue.length = 0;

      if (this.options.retainAfterFlush) {
        // Re-snapshot tracked entities
        for (const entry of this.trackedEntries.values()) {
          entry.snapshot = this.strategy.snapshot(entry.instance, entry.columnNames);
        }
      } else {
        this.trackedEntries.clear();
      }

      return result;
    } catch (error) {
      // On failure, restore queues so the user can retry
      this.insertQueue.length = 0;
      this.insertQueue.push(...insertsCopy);
      this.deleteQueue.length = 0;
      this.deleteQueue.push(...deletesCopy);
      throw error;
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  private validateEntity(entityClass: ClazzType<any>): void {
    const entities = this.ctx.getEntities();
    if (!entities.includes(entityClass)) {
      throw new Error(
        `Cannot track instance of "${entityClass.name}": not a registered entity. ` +
        `Make sure the class is decorated with @Entity() and registered with the EntityManager.`,
      );
    }
  }

  private getColumnInfo(entityClass: ClazzType<any>): {
    columnNames: string[];
    pkColumns: string[];
  } {
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];

    const columnNames = columns.map((c) => c.name ?? c.propertyKey!);
    const pkColumns = columns
      .filter((c) => c.options?.primary)
      .map((c) => c.name ?? c.propertyKey!);

    return { columnNames, pkColumns };
  }

  private buildPkWhere(entry: TrackedEntry): Record<string, any> {
    const where: Record<string, any> = {};
    for (const pk of entry.pkColumns) {
      where[pk] = entry.instance[pk];
    }
    return where;
  }
}
