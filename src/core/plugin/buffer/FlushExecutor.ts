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
   *
   * Retained for the UPDATE-batch path (`flushUpdatesBatched`), where
   * per-row WHERE version=? (optimistic locking) still requires per-row
   * SQL. The INSERT-batch path no longer uses this — #244 pre-injects
   * timestamps / initial version on each entry so those columns ride along
   * in the multi-row INSERT.
   */
  private hasOrmManagedFields(entityClass: ClazzType<any>): boolean {
    // @Version / @CreateTimestamp / @UpdateTimestamp store their metadata
    // on the class constructor (see each decorator). Earlier revisions
    // looked up on `entityClass.prototype`, which silently returned
    // undefined — the check was a no-op, so versioned entities flowed
    // through the batch UPDATE path bypassing their WHERE version=? guard.
    const hasVersion = Reflect.getMetadata(VERSION_TOKEN, entityClass);
    const hasCreateTs = Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, entityClass);
    const hasUpdateTs = Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, entityClass);
    return !!(hasVersion || hasCreateTs || hasUpdateTs);
  }

  /**
   * Pre-populate ORM-managed columns on each persist entry so the batched
   * multi-row INSERT carries explicit values instead of relying on DB
   * defaults or RETURNING:
   *
   * - `@CreateTimestamp` — set to `now` when unset.
   * - `@UpdateTimestamp` — always set to `now` (matches non-batched save()).
   * - `@Version`         — initialize to 1 when unset.
   *
   * Mutating the instance in place keeps parity with `WriteBuffer.ensureTimestamps` /
   * `ensureVersionIncrement` on the per-row path, so callers observe the
   * same post-flush instance state regardless of which flush strategy ran.
   */
  private injectOrmManagedFields(
    entityClass: ClazzType<any>,
    entries: PersistEntry[],
    now: Date,
  ): void {
    const versionCol = Reflect.getMetadata(VERSION_TOKEN, entityClass) as
      | string
      | undefined;
    const createCol = Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, entityClass) as
      | string
      | undefined;
    const updateCol = Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, entityClass) as
      | string
      | undefined;
    if (!versionCol && !createCol && !updateCol) return;

    for (const entry of entries) {
      const inst: any = entry.instance;
      if (createCol && (inst[createCol] === undefined || inst[createCol] === null)) {
        inst[createCol] = now;
      }
      if (updateCol) {
        inst[updateCol] = now;
      }
      if (versionCol && (inst[versionCol] === undefined || inst[versionCol] === null)) {
        inst[versionCol] = 1;
      }
    }
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

    // Single `now` per flush pass so every batched row in this flush shares
    // the same wall-clock timestamp (matches intuition for @CreateTimestamp
    // / @UpdateTimestamp on a logical transaction).
    const now = new Date();

    for (const [entityClass, entries] of groups) {
      // #244: inject ORM-managed values up-front so @Version /
      // @CreateTimestamp / @UpdateTimestamp entities ride along in the
      // multi-row INSERT instead of falling back to per-row save().
      this.injectOrmManagedFields(entityClass, entries, now);

      // Fallback to individual saves for: single entry, composite PK, or
      // SQLite (#159). Entities with @Version / @CreateTimestamp /
      // @UpdateTimestamp are no longer disqualified — their values were
      // just injected above.
      if (entries.length === 1 || entries[0].pkColumns.length > 1 || this.ctx.isSqlite?.()) {
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
          await this.cascade.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result, true);
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
        await this.cascade.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result, true);
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
   *
   * Delegates to `EntityManager.update`, the single canonical write path, so
   * operator WHERE clauses (`{ age: { gte: 18 } }`), NamingStrategy column
   * mapping (camelCase property → snake_case column), tenant scoping, and
   * `@UpdateTimestamp` injection are all handled uniformly. The previous
   * hand-rolled `col = ?` builder bound operator objects directly as `?`
   * parameters (broken SQL) and used the property name as the column name
   * (ignoring the NamingStrategy).
   */
  async executeBulkUpdate(
    txEm: EntityManager,
    entry: BulkUpdateEntry,
  ): Promise<void> {
    await txEm.update(entry.entity, entry.where as any, entry.set as any);
  }

  /**
   * Execute a bulk DELETE statement.
   *
   * Delegates to `EntityManager.delete` for the same reasons as
   * {@link executeBulkUpdate}: operator WHERE support, NamingStrategy column
   * mapping, and tenant scoping via the canonical write path.
   */
  async executeBulkDelete(
    txEm: EntityManager,
    entry: BulkDeleteEntry,
  ): Promise<void> {
    await txEm.delete(entry.entity, entry.where as any);
  }

  /**
   * After a bulk UPDATE, reconcile the in-memory identity map with the DB.
   *
   * For a plain equality WHERE + plain scalar SET, matchesWhere() reproduces
   * the DB's row selection exactly, so matching instances are synced in place
   * (apply SET values + re-snapshot). For an operator/combinator WHERE (or a
   * raw-`Sql` SET value) the row selection is resolved by the database and
   * cannot be reproduced faithfully in memory — so every tracked instance of
   * this entity is conservatively detached, forcing the next read to reload
   * fresh instead of serving a stale identity-map hit.
   */
  syncTrackedAfterBulkUpdate(
    entry: BulkUpdateEntry,
    trackedEntries: Map<EntityInstance, TrackedEntry>,
  ): void {
    if (!this.idMap.isPureEqualityWhere(entry.where) || !this.idMap.isPlainSetData(entry.set)) {
      this.detachAllTrackedOfEntity(entry.entity, trackedEntries);
      return;
    }
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
   * After a bulk DELETE, evict tracked instances whose rows were removed.
   *
   * A plain equality WHERE evicts exactly the matching tracked instances; an
   * operator/combinator WHERE conservatively detaches every tracked instance of
   * this entity (the DB decided which rows were deleted, and keeping any stale
   * identity-map entry risks a later phantom cache hit).
   */
  evictTrackedAfterBulkDelete(
    entry: BulkDeleteEntry,
    trackedEntries: Map<EntityInstance, TrackedEntry>,
  ): void {
    this.evictTrackedMatching(entry.entity, entry.where, trackedEntries);
  }

  /**
   * Evict the Identity-Map entries a DELETE of `entity` WHERE `where` removed.
   *
   * A plain equality WHERE evicts exactly the matching tracked instances; an
   * operator/combinator WHERE conservatively detaches every tracked instance of
   * this entity (the DB decided which rows were deleted, and keeping a stale
   * identity-map entry risks a later phantom cache hit of a deleted row).
   *
   * Shared by the bulk-DELETE path and the regular queued-DELETE path
   * (`buf.delete(entity, criteria)` and cascade deletes) so both keep the
   * first-level cache consistent with the database.
   */
  evictTrackedMatching(
    entity: ClazzType<any>,
    where: ColumnValueMap,
    trackedEntries: Map<EntityInstance, TrackedEntry>,
  ): void {
    if (!this.idMap.isPureEqualityWhere(where)) {
      this.detachAllTrackedOfEntity(entity, trackedEntries);
      return;
    }
    const toEvict: EntityInstance[] = [];
    for (const tracked of trackedEntries.values()) {
      if (tracked.entity !== entity) continue;
      if (!this.idMap.matchesWhere(tracked.instance, where)) continue;
      toEvict.push(tracked.instance);
    }
    for (const instance of toEvict) {
      this.idMap.detachTracked(instance, trackedEntries);
    }
  }

  /**
   * Detach every tracked instance of a given entity class — used to
   * conservatively invalidate the identity map after a bulk op whose WHERE
   * clause cannot be matched precisely in memory.
   */
  private detachAllTrackedOfEntity(
    entity: ClazzType<any>,
    trackedEntries: Map<EntityInstance, TrackedEntry>,
  ): void {
    const toDetach: EntityInstance[] = [];
    for (const tracked of trackedEntries.values()) {
      if (tracked.entity === entity) toDetach.push(tracked.instance);
    }
    for (const instance of toDetach) {
      this.idMap.detachTracked(instance, trackedEntries);
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
