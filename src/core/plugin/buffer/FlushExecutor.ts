/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { ENTITY_TOKEN } from "../../../decorators/Entity";
import { VERSION_TOKEN } from "../../../decorators/Version";
import { CREATE_TIMESTAMP_TOKEN } from "../../../decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../../../decorators/UpdateTimestamp";
import { PluginContext } from "../PluginContext";
import { TrackedEntry, PersistEntry } from "./BufferEntry";
import {
  BufferFlushResult, BufferPluginOptions,
  FlushEventType, FlushEvent, FlushEventListener,
  BulkUpdateEntry, BulkDeleteEntry,
  ResolvedBufferOptions,
} from "./BufferPreview";
import { BufferStrategy } from "./BufferStrategy";
import { EntityState } from "./EntityUnitState";
import { IdentityMapManager, EntityInstance, ColumnValueMap } from "./IdentityMapManager";
import { CascadeProcessor } from "./CascadeProcessor";
import type { EntityManager } from "../../EntityManager";

/**
 * Executes flush operations: batch INSERT/UPDATE, bulk DML, and flush events.
 *
 * Extracted from WriteBuffer to isolate DML execution concerns.
 */
export class FlushExecutor {
  private readonly ctx: PluginContext;
  private readonly idMap: IdentityMapManager;
  private readonly cascade: CascadeProcessor;
  private readonly options: ResolvedBufferOptions;
  private readonly strategy: BufferStrategy;
  private readonly flushListeners: Map<FlushEventType, FlushEventListener[]>;

  constructor(
    ctx: PluginContext,
    idMap: IdentityMapManager,
    cascade: CascadeProcessor,
    options: ResolvedBufferOptions,
    strategy: BufferStrategy,
    flushListeners: Map<FlushEventType, FlushEventListener[]>,
  ) {
    this.ctx = ctx;
    this.idMap = idMap;
    this.cascade = cascade;
    this.options = options;
    this.strategy = strategy;
    this.flushListeners = flushListeners;
  }

  /**
   * #162/#163: Check if entity has ORM-managed metadata (version, timestamps)
   * that would be bypassed by batch operations.
   */
  private hasOrmManagedFields(entityClass: ClazzType<any>): boolean {
    const hasVersion = Reflect.getMetadata(VERSION_TOKEN, entityClass.prototype);
    const hasCreateTs = Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, entityClass.prototype);
    const hasUpdateTs = Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, entityClass.prototype);
    return !!(hasVersion || hasCreateTs || hasUpdateTs);
  }

  /**
   * Batch INSERT for multiple entities of the same type.
   * Groups by entity class, builds multi-row INSERT, writes back generated PKs.
   */
  async flushPersistsBatched(
    txEm: EntityManager,
    persists: PersistEntry[],
    visited: Set<EntityInstance>,
    result: BufferFlushResult,
  ): Promise<void> {
    // Group by entity class
    const groups = new Map<ClazzType<any>, PersistEntry[]>();
    for (const entry of persists) {
      let arr = groups.get(entry.entity);
      if (!arr) {
        arr = [];
        groups.set(entry.entity, arr);
      }
      arr.push(entry);
    }

    for (const [entityClass, entries] of groups) {
      // Fallback to individual saves for: single entry, composite PK,
      // SQLite (#159), or entities with version/timestamp (#162)
      if (entries.length === 1 || entries[0].pkColumns.length > 1 || this.ctx.isSqlite?.() || this.hasOrmManagedFields(entityClass)) {
        for (const entry of entries) {
          const saveData = this.idMap.extractColumnData(entry.instance, entry.columnNames);
          const saved = await txEm.save(entry.entity, saveData);
          if (saved) {
            for (const col of entry.columnNames) {
              const v = (saved as any)[col];
              if (v !== undefined) entry.instance[col] = v;
            }
          }
          result.inserts++;
          visited.add(entry.instance);
          await this.cascade.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
        }
        continue;
      }

      // Get table name from entity metadata
      const entityMeta = Reflect.getMetadata(ENTITY_TOKEN, entityClass);
      const tableName = entityMeta?.name || entityClass.name;
      const wrappedTable = this.ctx.wrapTable(tableName);

      // Determine non-PK columns that have values
      const nonPkCols = entries[0].columnNames.filter(
        c => !entries[0].pkColumns.includes(c),
      );
      const wrappedCols = nonPkCols.map(c => this.ctx.wrap(c));

      // Build parameter placeholders and values
      const params: any[] = [];
      const rowPlaceholders: string[] = [];
      for (const entry of entries) {
        const placeholders = nonPkCols.map(() => "?");
        rowPlaceholders.push(`(${placeholders.join(", ")})`);
        for (const col of nonPkCols) {
          params.push(entry.instance[col] ?? null);
        }
      }

      const sql = `INSERT INTO ${wrappedTable} (${wrappedCols.join(", ")}) VALUES ${rowPlaceholders.join(", ")}`;

      if (this.ctx.isPostgres()) {
        // PostgreSQL: add RETURNING pkCol
        const pkCol = entries[0].pkColumns[0];
        const returningSql = `${sql} RETURNING ${this.ctx.wrap(pkCol)}`;
        const rows = await txEm.query(returningSql, params);
        if (Array.isArray(rows)) {
          for (let i = 0; i < entries.length && i < rows.length; i++) {
            entries[i].instance[pkCol] = (rows[i] as any)[pkCol];
          }
        }
      } else {
        // MySQL: LAST_INSERT_ID() returns first auto-increment of batch
        const queryResult = await txEm.query(sql, params);
        const pkCol = entries[0].pkColumns[0];
        // Try to extract insertId from query result
        const insertId =
          (queryResult as any)?.insertId ??
          (Array.isArray(queryResult) && (queryResult[0] as any)?.insertId);
        if (typeof insertId === "number" && insertId > 0) {
          for (let i = 0; i < entries.length; i++) {
            entries[i].instance[pkCol] = insertId + i;
          }
        }
      }

      result.inserts += entries.length;
      for (const entry of entries) {
        visited.add(entry.instance);
        await this.cascade.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
      }
    }
  }

  /**
   * Batch UPDATE for multiple dirty entities of the same type.
   * Uses CASE WHEN pk = ? THEN ? END expressions per changed column.
   */
  async flushUpdatesBatched(
    txEm: EntityManager,
    sortedTracked: TrackedEntry[],
    visited: Set<EntityInstance>,
    result: BufferFlushResult,
  ): Promise<void> {
    // Collect dirty entries
    const dirtyEntries: { entry: TrackedEntry; diff: ColumnValueMap }[] = [];
    for (const entry of sortedTracked) {
      const diff = this.strategy.diff(
        entry.instance,
        entry.snapshot,
        entry.columnNames,
        entry.pkColumns,
      );
      if (diff) {
        dirtyEntries.push({ entry, diff });
      }
    }

    if (dirtyEntries.length === 0) return;

    // Group by entity class
    const groups = new Map<ClazzType<any>, { entry: TrackedEntry; diff: ColumnValueMap }[]>();
    for (const item of dirtyEntries) {
      let arr = groups.get(item.entry.entity);
      if (!arr) {
        arr = [];
        groups.set(item.entry.entity, arr);
      }
      arr.push(item);
    }

    for (const [entityClass, items] of groups) {
      // Fallback to individual save for: single item, composite PK, or entities with version/timestamp (#163)
      if (items.length === 1 || items[0].entry.pkColumns.length > 1 || this.hasOrmManagedFields(entityClass)) {
        for (const { entry } of items) {
          const saveData = this.idMap.extractColumnData(entry.instance, entry.columnNames);
          const updated = await txEm.save(entry.entity, saveData);
          if (updated) {
            for (const col of entry.columnNames) {
              const freshValue = (updated as any)[col];
              if (freshValue !== undefined) entry.instance[col] = freshValue;
            }
          }
          result.updates++;
          visited.add(entry.instance);
          await this.cascade.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
        }
        continue;
      }

      // Build batch UPDATE with CASE WHEN
      const entityMeta = Reflect.getMetadata(ENTITY_TOKEN, entityClass);
      const tableName = entityMeta?.name || entityClass.name;
      const wrappedTable = this.ctx.wrapTable(tableName);
      const pkCol = items[0].entry.pkColumns[0];
      const wrappedPk = this.ctx.wrap(pkCol);

      // Collect all changed columns across all items
      const changedCols = new Set<string>();
      for (const { diff } of items) {
        for (const col of Object.keys(diff)) changedCols.add(col);
      }

      const setClauses: string[] = [];
      const params: any[] = [];

      for (const col of changedCols) {
        const wrappedCol = this.ctx.wrap(col);
        const cases: string[] = [];
        for (const { entry, diff } of items) {
          if (col in diff) {
            cases.push(`WHEN ${wrappedPk} = ? THEN ?`);
            params.push(entry.instance[pkCol], diff[col]);
          }
        }
        if (cases.length > 0) {
          setClauses.push(`${wrappedCol} = CASE ${cases.join(" ")} ELSE ${wrappedCol} END`);
        }
      }

      // WHERE pk IN (...)
      const pkValues = items.map(({ entry }) => entry.instance[pkCol]);
      const placeholders = pkValues.map(() => "?").join(", ");
      params.push(...pkValues);

      const sql = `UPDATE ${wrappedTable} SET ${setClauses.join(", ")} WHERE ${wrappedPk} IN (${placeholders})`;
      await txEm.query(sql, params);

      result.updates += items.length;
      for (const { entry } of items) {
        visited.add(entry.instance);
        await this.cascade.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
      }
    }
  }

  /**
   * Execute a bulk UPDATE statement.
   */
  async executeBulkUpdate(
    txEm: EntityManager,
    entry: BulkUpdateEntry,
  ): Promise<void> {
    const entityMeta = Reflect.getMetadata(ENTITY_TOKEN, entry.entity);
    const tableName = entityMeta?.name || entry.entity.name;
    const wrappedTable = this.ctx.wrapTable(tableName);

    const setClauses: string[] = [];
    const params: any[] = [];

    for (const [col, val] of Object.entries(entry.set)) {
      setClauses.push(`${this.ctx.wrap(col)} = ?`);
      params.push(val);
    }

    const whereClauses: string[] = [];
    for (const [col, val] of Object.entries(entry.where)) {
      whereClauses.push(`${this.ctx.wrap(col)} = ?`);
      params.push(val);
    }

    const sql = `UPDATE ${wrappedTable} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;
    await txEm.query(sql, params);
  }

  /**
   * Execute a bulk DELETE statement.
   */
  async executeBulkDelete(
    txEm: EntityManager,
    entry: BulkDeleteEntry,
  ): Promise<void> {
    const entityMeta = Reflect.getMetadata(ENTITY_TOKEN, entry.entity);
    const tableName = entityMeta?.name || entry.entity.name;
    const wrappedTable = this.ctx.wrapTable(tableName);

    const whereClauses: string[] = [];
    const params: any[] = [];

    for (const [col, val] of Object.entries(entry.where)) {
      whereClauses.push(`${this.ctx.wrap(col)} = ?`);
      params.push(val);
    }

    const sql = `DELETE FROM ${wrappedTable} WHERE ${whereClauses.join(" AND ")}`;
    await txEm.query(sql, params);
  }

  /**
   * After a bulk UPDATE, sync tracked in-memory instances that match
   * the WHERE clause: apply SET values and re-snapshot.
   */
  syncTrackedAfterBulkUpdate(
    entry: BulkUpdateEntry,
    trackedEntries: Map<EntityInstance, TrackedEntry>,
  ): void {
    for (const tracked of trackedEntries.values()) {
      if (tracked.entity !== entry.entity) continue;
      if (!this.idMap.matchesWhere(tracked.instance, entry.where)) continue;
      for (const [col, val] of Object.entries(entry.set)) {
        tracked.instance[col] = val;
      }
      tracked.snapshot = this.strategy.snapshot(tracked.instance, tracked.columnNames);
    }
  }

  /**
   * After a bulk DELETE, evict tracked instances that match the WHERE clause
   * from identityMap, trackedEntries, and stateMap.
   *
   * Fixed: builds identity key BEFORE deleting from trackedEntries (was O(n) bug).
   */
  evictTrackedAfterBulkDelete(
    entry: BulkDeleteEntry,
    trackedEntries: Map<EntityInstance, TrackedEntry>,
  ): void {
    const toEvict: EntityInstance[] = [];
    for (const tracked of trackedEntries.values()) {
      if (tracked.entity !== entry.entity) continue;
      if (!this.idMap.matchesWhere(tracked.instance, entry.where)) continue;
      toEvict.push(tracked.instance);
    }
    for (const instance of toEvict) {
      // Build identity key BEFORE deleting from trackedEntries (fix: was O(n) scan)
      const tracked = trackedEntries.get(instance);
      if (tracked) {
        const key = this.idMap.buildIdentityKey(tracked.entity, instance, tracked.pkColumns);
        this.idMap.identityMap.delete(key);
      }
      trackedEntries.delete(instance);
      this.idMap.stateMap.set(instance, EntityState.DETACHED);
    }
  }

  /**
   * Emit a flush event to registered listeners.
   */
  async emitFlushEvent(
    type: FlushEventType,
    entity: ClazzType<any>,
    instance?: EntityInstance,
    data?: ColumnValueMap,
    criteria?: ColumnValueMap,
  ): Promise<void> {
    const listeners = this.flushListeners.get(type);
    if (!listeners || listeners.length === 0) return;
    const event: FlushEvent = { type, entity, instance, data, criteria };
    for (const listener of listeners) {
      await listener(event);
    }
  }
}
