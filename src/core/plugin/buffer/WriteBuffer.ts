/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import { ColumnMetadata } from "../../../scanner/ColumnScanner";
import { FindOption } from "../../../dialects/FindOption";
import { PluginContext } from "../PluginContext";
import { TrackedEntry, InsertEntry, DeleteEntry } from "./BufferEntry";
import { BufferPreviewEntry, BufferFlushResult, BufferPluginOptions } from "./BufferPreview";
import { BufferStrategy, SnapshotStrategy } from "./BufferStrategy";

/**
 * WriteBuffer — buffers entity writes and flushes them in a single transaction.
 *
 * Maintains an Identity Map scoped to this WriteBuffer instance:
 * the same database row (identified by entity class + PK) is always
 * represented by the same object reference. This prevents duplicate
 * tracking and conflicting updates on flush().
 *
 * Created via `em.buffer()` after installing the buffer plugin.
 */
export class WriteBuffer {
  private readonly trackedEntries = new Map<any, TrackedEntry>();
  private readonly identityMap = new Map<string, any>();
  private readonly insertQueue: InsertEntry[] = [];
  private readonly deleteQueue: DeleteEntry[] = [];
  private readonly strategy: BufferStrategy;
  private readonly ctx: PluginContext;
  private readonly options: Required<BufferPluginOptions>;

  constructor(
    ctx: PluginContext,
    options: BufferPluginOptions = {},
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
   *
   * If another instance with the same PK is already tracked,
   * throws an error to prevent conflicting updates.
   */
  track(instance: any): this {
    if (this.trackedEntries.has(instance)) {
      return this; // idempotent — same reference
    }

    const entityClass = instance.constructor as ClazzType<any>;
    this.validateEntity(entityClass);

    const { columnNames, pkColumns } = this.getColumnInfo(entityClass);

    // Identity Map check — prevent two different instances for the same PK
    const key = this.buildIdentityKey(entityClass, instance, pkColumns);
    const existing = this.identityMap.get(key);
    if (existing && existing !== instance) {
      throw new Error(
        `Identity conflict: another instance of "${entityClass.name}" with PK (${key}) is already tracked. ` +
        `Use the existing tracked instance, or untrack() the old one first.`,
      );
    }

    const snapshot = this.strategy.snapshot(instance, columnNames);

    this.trackedEntries.set(instance, {
      entity: entityClass,
      instance,
      snapshot,
      columnNames,
      pkColumns,
    });
    this.identityMap.set(key, instance);

    return this;
  }

  /**
   * Load a single entity and automatically track it.
   *
   * If an entity with the same PK is already in the Identity Map,
   * returns the existing tracked instance (DB is still queried to
   * confirm the row exists, but the cached reference is returned).
   *
   * Returns `null` if no matching row is found.
   */
  async findOne<T>(
    entity: ClazzType<T>,
    option: FindOption<T>,
  ): Promise<T | null> {
    const result = await this.ctx.em.findOne(entity, option);
    if (result === null) return null;
    return this.resolveIdentity(entity, result) as T;
  }

  /**
   * Load multiple entities and automatically track them all.
   *
   * For each result, if an entity with the same PK is already in
   * the Identity Map, the existing tracked instance is used instead.
   */
  async find<T>(
    entity: ClazzType<T>,
    option: FindOption<T> = {},
  ): Promise<T[]> {
    const results = await this.ctx.em.find(entity, option);
    return results.map((item) => this.resolveIdentity(entity, item) as T);
  }

  /**
   * Queue an INSERT operation.
   */
  save(entityClass: ClazzType<any>, data: Record<string, any>): this {
    this.validateEntity(entityClass);
    this.insertQueue.push({ entity: entityClass, data });
    return this;
  }

  /**
   * Queue a DELETE operation.
   */
  delete(entityClass: ClazzType<any>, criteria: Record<string, any>): this {
    this.validateEntity(entityClass);
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
   * Remove a specific entity from tracking and the Identity Map.
   */
  untrack(instance: any): this {
    const entry = this.trackedEntries.get(instance);
    if (entry) {
      const key = this.buildIdentityKey(entry.entity, instance, entry.pkColumns);
      this.identityMap.delete(key);
    }
    this.trackedEntries.delete(instance);
    return this;
  }

  /**
   * Clear all tracked entities, Identity Map, and queued operations.
   */
  clear(): this {
    this.trackedEntries.clear();
    this.identityMap.clear();
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
  preview(): BufferPreviewEntry[] {
    const entries: BufferPreviewEntry[] = [];

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
  async flush(): Promise<BufferFlushResult> {
    // No-op if nothing to do (avoids unnecessary diff computation)
    if (!this.hasPendingWork()) {
      return { updates: 0, inserts: 0, deletes: 0 };
    }

    const em = this.ctx.em;
    const result: BufferFlushResult = { updates: 0, inserts: 0, deletes: 0 };

    // Capture queues before flush (for retry on failure)
    const insertsCopy = [...this.insertQueue];
    const deletesCopy = [...this.deleteQueue];

    try {
      await em.transaction(async (txEm) => {
        // 1. Updates — dirty tracked entities
        //    Uses em.save() to get @Version optimistic locking,
        //    lifecycle hooks, and EntitySubscriber events.
        for (const entry of this.trackedEntries.values()) {
          const diff = this.strategy.diff(
            entry.instance,
            entry.snapshot,
            entry.columnNames,
            entry.pkColumns,
          );
          if (diff) {
            const updated = await txEm.save(entry.entity, entry.instance);
            // Sync auto-updated columns back (version, timestamps, etc.)
            if (updated) {
              for (const col of entry.columnNames) {
                const freshValue = (updated as any)[col];
                if (freshValue !== undefined) {
                  entry.instance[col] = freshValue;
                }
              }
            }
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
        this.identityMap.clear();
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

  private resolveIdentity(entityClass: ClazzType<any>, instance: any): any {
    const { pkColumns } = this.getColumnInfo(entityClass);
    const key = this.buildIdentityKey(entityClass, instance, pkColumns);

    const existing = this.identityMap.get(key);
    if (existing) {
      return existing;
    }

    this.track(instance);
    return instance;
  }

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

  private buildIdentityKey(
    entityClass: ClazzType<any>,
    instance: any,
    pkColumns: string[],
  ): string {
    const pkParts = pkColumns.map((pk) => {
      const value = instance[pk];
      if (value === undefined || value === null) {
        throw new Error(
          `Cannot track instance of "${entityClass.name}": PK column "${pk}" is ${value}. ` +
          `Only persisted entities with assigned PK values can be tracked. ` +
          `Use save() to queue new entities for insertion instead.`,
        );
      }
      return `${pk}=${value}`;
    }).join(",");
    return `${entityClass.name}:${pkParts}`;
  }

  private hasPendingWork(): boolean {
    if (this.insertQueue.length > 0 || this.deleteQueue.length > 0) {
      return true;
    }
    for (const entry of this.trackedEntries.values()) {
      const diff = this.strategy.diff(
        entry.instance,
        entry.snapshot,
        entry.columnNames,
        entry.pkColumns,
      );
      if (diff) return true;
    }
    return false;
  }

  private buildPkWhere(entry: TrackedEntry): Record<string, any> {
    const where: Record<string, any> = {};
    for (const pk of entry.pkColumns) {
      where[pk] = entry.instance[pk];
    }
    return where;
  }
}
