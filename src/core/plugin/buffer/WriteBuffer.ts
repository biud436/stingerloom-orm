/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { FindOption } from "../../../dialects/FindOption";
import { PluginContext } from "../PluginContext";
import { TrackedEntry, InsertEntry, DeleteEntry, PersistEntry } from "./BufferEntry";
import {
  BufferPreviewEntry, BufferFlushResult, BufferPluginOptions, BufferChangeset,
  ChangeTrackingPolicy, FlushMode,
  FlushEventType, FlushEventListener,
  BulkUpdateEntry, BulkDeleteEntry,
} from "./BufferPreview";
import { BufferStrategy, SnapshotStrategy } from "./BufferStrategy";
import { EntityState } from "./EntityUnitState";
import { sortForInsert, sortForDelete, buildTopologicalIndexMap, sortByIndex } from "./DependencyGraph";
import { snapshotCollections, diffCollection } from "./CollectionTracker";
import { createPersistentCollection } from "./PersistentCollection";
import { IdentityMapManager } from "./IdentityMapManager";
import { CascadeProcessor } from "./CascadeProcessor";
import { FlushExecutor } from "./FlushExecutor";
import { LazyRelationInjector } from "./LazyRelationInjector";
import type { EntityManager } from "../../EntityManager";

/**
 * WriteBuffer — buffers entity writes and flushes them in a single transaction.
 *
 * Maintains an Identity Map scoped to this WriteBuffer instance:
 * the same database row (identified by entity class + PK) is always
 * represented by the same object reference. This prevents duplicate
 * tracking and conflicting updates on flush().
 *
 * Created via `em.buffer()` after installing the buffer plugin.
 *
 * This class is a thin facade that delegates to:
 * - IdentityMapManager: identity map, entity metadata helpers
 * - CascadeProcessor: cascade insert/update/delete propagation
 * - FlushExecutor: batch DML, bulk ops, flush events
 * - LazyRelationInjector: lazy proxy injection for all relation types
 */
export class WriteBuffer {
  private readonly trackedEntries = new Map<any, TrackedEntry>();
  private readonly insertQueue: InsertEntry[] = [];
  private readonly deleteQueue: DeleteEntry[] = [];
  private readonly persistQueue: PersistEntry[] = [];
  private readonly bulkUpdateQueue: BulkUpdateEntry[] = [];
  private readonly bulkDeleteQueue: BulkDeleteEntry[] = [];
  private readonly strategy: BufferStrategy;
  private readonly ctx: PluginContext;
  private readonly options: Required<BufferPluginOptions>;
  private readonly flushMode: FlushMode;
  private readonly changeTracking: ChangeTrackingPolicy;
  private readonly flushListeners = new Map<FlushEventType, FlushEventListener[]>();
  /** Parent buffer for nested UoW (savepoint) */
  private readonly parent?: WriteBuffer;

  // ── Sub-modules ──
  private readonly idMap: IdentityMapManager;
  private readonly cascade: CascadeProcessor;
  private readonly flushExec: FlushExecutor;
  private readonly lazyInjector: LazyRelationInjector;

  constructor(
    ctx: PluginContext,
    options: BufferPluginOptions = {},
    parent?: WriteBuffer,
  ) {
    this.ctx = ctx;
    this.parent = parent;
    this.strategy = new SnapshotStrategy();
    this.options = {
      retainAfterFlush: options.retainAfterFlush ?? true,
      cascade: options.cascade ?? true,
      orphanRemoval: options.orphanRemoval ?? false,
      manyToManySync: options.manyToManySync ?? (options.cascade !== false),
      autoFlush: options.autoFlush ?? false,
      flushMode: options.flushMode ?? (options.autoFlush ? FlushMode.AUTO : FlushMode.MANUAL),
      onFlush: options.onFlush ?? (() => {}),
      batchInsert: options.batchInsert ?? false,
      batchUpdate: options.batchUpdate ?? false,
      changeTracking: options.changeTracking ?? ChangeTrackingPolicy.DEFERRED_IMPLICIT,
      logging: options.logging ?? false,
    };
    this.flushMode = this.options.flushMode;
    this.changeTracking = this.options.changeTracking;

    if (this.options.logging) {
      this.log("buffer created", {
        flushMode: this.flushMode,
        changeTracking: this.changeTracking,
        cascade: this.options.cascade,
        batchInsert: this.options.batchInsert,
        batchUpdate: this.options.batchUpdate,
      });
    }

    // Initialize sub-modules
    this.idMap = new IdentityMapManager(ctx);
    this.cascade = new CascadeProcessor(ctx, this.idMap, this.options);
    this.flushExec = new FlushExecutor(
      ctx, this.idMap, this.cascade, this.options, this.strategy, this.flushListeners,
    );
    this.lazyInjector = new LazyRelationInjector(
      ctx, this.idMap, this.resolveIdentity.bind(this),
    );
  }

  // ── Entity State ─────────────────────────────────────────────

  /**
   * Returns the current lifecycle state of an entity instance.
   */
  getState(instance: any): EntityState {
    return (this.idMap.stateMap.get(instance) as EntityState) ?? EntityState.DETACHED;
  }

  // ── Tracking ─────────────────────────────────────────────────

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
    this.idMap.validateEntity(entityClass);

    const { columnNames, pkColumns } = this.idMap.getColumnInfo(entityClass);

    // Identity Map check — prevent two different instances for the same PK
    const key = this.idMap.buildIdentityKey(entityClass, instance, pkColumns);
    const existing = this.idMap.identityMap.get(key);
    if (existing && existing !== instance) {
      throw new Error(
        `Identity conflict: another instance of "${entityClass.name}" with PK (${key}) is already tracked. ` +
        `Use the existing tracked instance, or untrack() the old one first.`,
      );
    }

    const snapshot = this.strategy.snapshot(instance, columnNames);
    const collectionSnapshots = snapshotCollections(instance, entityClass);

    this.trackedEntries.set(instance, {
      entity: entityClass,
      instance,
      snapshot,
      columnNames,
      pkColumns,
      collectionSnapshots: collectionSnapshots.length > 0 ? collectionSnapshots : undefined,
    });
    this.idMap.identityMap.set(key, instance);
    this.idMap.stateMap.set(instance, EntityState.MANAGED);

    if (this.options.logging) this.log("track", { entity: entityClass.name, key });

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
   *
   * @param lock — Pessimistic lock mode. Lock is acquired during flush() transaction.
   */
  async findOne<T>(
    entity: ClazzType<T>,
    option: FindOption<T> = {},
  ): Promise<T | null> {
    // First-level cache: skip DB for simple PK lookups already in the Identity Map.
    // FlushMode.ALWAYS is excluded — its contract is to always hit the DB.
    if (this.flushMode !== FlushMode.ALWAYS) {
      const cacheKey = this.idMap.tryBuildCacheKey(entity, option);
      if (cacheKey !== null) {
        const cached = this.idMap.identityMap.get(cacheKey);
        if (cached) {
          await this.autoFlushIfNeeded();
          if (this.options.logging) {
            this.log("findOne → cache hit (skip DB)", {
              entity: entity.name, key: cacheKey, identityMapHit: true,
            });
          }
          return cached as T;
        }
      }
    }

    await this.autoFlushIfNeeded();
    const result = await this.ctx.em.findOne(entity, option);
    if (result === null) {
      if (this.options.logging) this.log("findOne → null", { entity: entity.name });
      return null;
    }
    const tracked = this.resolveIdentity(entity, result) as T;
    if (this.options.logging) {
      const { pkColumns } = this.idMap.getColumnInfo(entity);
      const key = this.idMap.buildIdentityKey(entity, result, pkColumns);
      const fromMap = this.idMap.identityMap.get(key) === tracked && tracked !== result;
      this.log("findOne → tracked", { entity: entity.name, key, identityMapHit: fromMap });
    }
    return tracked;
  }

  /**
   * Load multiple entities and automatically track them all.
   *
   * For each result, if an entity with the same PK is already in
   * the Identity Map, the existing tracked instance is used instead.
   *
   * @param lock — Pessimistic lock mode. Lock is acquired during flush() transaction.
   */
  async find<T>(
    entity: ClazzType<T>,
    option: FindOption<T> = {},
  ): Promise<T[]> {
    await this.autoFlushIfNeeded();
    const results = await this.ctx.em.find(entity, option);
    return results.map((item) => {
      const tracked = this.resolveIdentity(entity, item) as T;
      return tracked;
    });
  }

  /**
   * Get or create a lightweight reference for an entity by PK.
   *
   * Returns an identity-mapped instance with only PK columns set.
   * Useful for setting FK references without a database roundtrip:
   *
   * ```ts
   * comment.post = buf.getReference(Post, 1);
   * ```
   *
   * If an entity with the same PK is already in the Identity Map,
   * returns the existing tracked instance.
   *
   * Relation properties are initialized as lazy proxies — accessing them
   * triggers a DB query and registers the loaded entities in this buffer.
   */
  getReference<T>(entityClass: ClazzType<T>, pk: any): T {
    this.idMap.validateEntity(entityClass);
    const { pkColumns } = this.idMap.getColumnInfo(entityClass);

    // Normalize PK — support both scalar and object form
    const instance = new entityClass() as any;
    if (pkColumns.length === 1 && (typeof pk !== "object" || pk === null || pk instanceof Date)) {
      instance[pkColumns[0]] = pk;
    } else if (typeof pk === "object" && pk !== null) {
      for (const [k, v] of Object.entries(pk)) {
        instance[k] = v;
      }
    }

    // Check identity map — return existing if found
    const key = this.idMap.buildIdentityKey(entityClass, instance, pkColumns);
    const existing = this.idMap.identityMap.get(key);
    if (existing) return existing as T;

    // Register in identity map (not snapshot-tracked — reference only)
    this.idMap.identityMap.set(key, instance);
    this.idMap.stateMap.set(instance, EntityState.MANAGED);

    // Inject lazy proxies for relation properties
    this.lazyInjector.injectLazyRelations(instance, entityClass);

    return instance as T;
  }

  // ── Change Tracking ─────────────────────────────────────────────

  /**
   * Explicitly mark a tracked entity as dirty (for DEFERRED_EXPLICIT policy).
   * Under DEFERRED_IMPLICIT, entities are always dirty-checked automatically.
   */
  markDirty(instance: any): this {
    const entry = this.trackedEntries.get(instance);
    if (!entry) {
      throw new Error(
        `Cannot markDirty: instance of "${instance.constructor.name}" is not tracked.`,
      );
    }
    entry.explicitDirty = true;
    return this;
  }

  // ── Read-only Entities ─────────────────────────────────────────

  /**
   * Mark a tracked entity as read-only (immutable).
   * Read-only entities are skipped during dirty checking on flush.
   */
  markReadOnly(instance: any): this {
    const entry = this.trackedEntries.get(instance);
    if (!entry) {
      throw new Error(
        `Cannot markReadOnly: instance of "${instance.constructor.name}" is not tracked.`,
      );
    }
    entry.readOnly = true;
    return this;
  }

  /**
   * Check if a tracked entity is marked as read-only.
   */
  isReadOnly(instance: any): boolean {
    return this.trackedEntries.get(instance)?.readOnly === true;
  }

  // ── Bulk DML ───────────────────────────────────────────────────

  /**
   * Queue a bulk UPDATE operation.
   * Executes `UPDATE table SET ... WHERE ...` during flush.
   */
  updateMany<T>(
    entity: ClazzType<T>,
    options: { where: Record<string, any>; set: Record<string, any> },
  ): this {
    this.idMap.validateEntity(entity);
    this.bulkUpdateQueue.push({ entity, where: options.where, set: options.set });
    return this;
  }

  /**
   * Queue a bulk DELETE operation.
   * Executes `DELETE FROM table WHERE ...` during flush.
   */
  deleteMany<T>(entity: ClazzType<T>, where: Record<string, any>): this {
    this.idMap.validateEntity(entity);
    this.bulkDeleteQueue.push({ entity, where });
    return this;
  }

  // ── Flush Events ───────────────────────────────────────────────

  /**
   * Register a per-entity flush event listener.
   */
  onFlushEvent(type: FlushEventType, listener: FlushEventListener): this {
    let listeners = this.flushListeners.get(type);
    if (!listeners) {
      listeners = [];
      this.flushListeners.set(type, listeners);
    }
    listeners.push(listener);
    return this;
  }

  // ── Nested UoW (Savepoint) ─────────────────────────────────────

  /**
   * Create a nested WriteBuffer for savepoint-scoped work.
   */
  beginNested(): WriteBuffer {
    return new WriteBuffer(this.ctx, this.options, this);
  }

  // ── Persistent Collections ─────────────────────────────────────

  /**
   * Wrap an entity's collection property with a PersistentCollection proxy.
   */
  wrapCollection<T>(instance: any, propertyKey: string): T[] {
    const entry = this.trackedEntries.get(instance);
    if (!entry) {
      throw new Error(
        `Cannot wrapCollection: instance of "${instance.constructor.name}" is not tracked.`,
      );
    }
    const arr = instance[propertyKey];
    if (!Array.isArray(arr)) {
      throw new Error(
        `Cannot wrapCollection: "${propertyKey}" is not an array.`,
      );
    }
    const wrapped = createPersistentCollection(arr, () => {
      if (entry) entry.explicitDirty = true;
    });
    instance[propertyKey] = wrapped;
    return wrapped;
  }

  // ── CRUD queuing ───────────────────────────────────────────────

  /**
   * Queue an INSERT operation.
   */
  save(entityClass: ClazzType<any>, data: Record<string, any>): this {
    this.idMap.validateEntity(entityClass);
    this.insertQueue.push({ entity: entityClass, data });
    return this;
  }

  /**
   * Queue a DELETE operation.
   */
  delete(entityClass: ClazzType<any>, criteria: Record<string, any>): this {
    this.idMap.validateEntity(entityClass);
    this.deleteQueue.push({ entity: entityClass, criteria });
    return this;
  }

  /**
   * Register an entity instance for insertion.
   */
  persist(instance: any): this {
    const entityClass = instance.constructor as ClazzType<any>;
    this.idMap.validateEntity(entityClass);
    const { columnNames, pkColumns } = this.idMap.getColumnInfo(entityClass);

    const hasPk = pkColumns.every(pk => {
      const v = instance[pk];
      return v !== undefined && v !== null;
    });

    if (hasPk) return this.track(instance);

    // Idempotent — same reference
    if (this.persistQueue.some(e => e.instance === instance)) return this;

    this.persistQueue.push({ entity: entityClass, instance, columnNames, pkColumns });
    this.idMap.stateMap.set(instance, EntityState.NEW);
    if (this.options.logging) this.log("persist (queued INSERT)", { entity: entityClass.name });
    return this;
  }

  /**
   * Mark an entity instance for deletion.
   */
  remove(instance: any): this {
    const entityClass = instance.constructor as ClazzType<any>;
    this.idMap.validateEntity(entityClass);
    const { pkColumns } = this.idMap.getColumnInfo(entityClass);

    // Build criteria from PK
    const criteria: Record<string, any> = {};
    for (const pk of pkColumns) {
      const v = instance[pk];
      if (v === undefined || v === null) {
        throw new Error(
          `Cannot remove "${entityClass.name}": PK "${pk}" is ${v}.`,
        );
      }
      criteria[pk] = v;
    }

    // Untrack if tracked
    if (this.trackedEntries.has(instance)) this.untrack(instance);

    // If in persistQueue → cancel INSERT, no DELETE needed
    const idx = this.persistQueue.findIndex(e => e.instance === instance);
    if (idx !== -1) {
      this.persistQueue.splice(idx, 1);
      this.idMap.stateMap.set(instance, EntityState.DETACHED);
      return this;
    }

    this.deleteQueue.push({ entity: entityClass, criteria });
    this.idMap.stateMap.set(instance, EntityState.REMOVED);
    if (this.options.logging) this.log("remove (queued DELETE)", { entity: entityClass.name, criteria });
    return this;
  }

  /**
   * Detach an entity from the buffer entirely.
   * When cascade is enabled, propagates detach to related entities.
   */
  detach(instance: any, visited?: Set<any>): this {
    const seen = visited ?? new Set<any>();
    if (seen.has(instance)) return this;
    seen.add(instance);

    // Remove from persist queue if present
    const idx = this.persistQueue.findIndex(e => e.instance === instance);
    if (idx !== -1) this.persistQueue.splice(idx, 1);

    // Remove from tracking + identity map
    const entry = this.trackedEntries.get(instance);
    if (entry) {
      const key = this.idMap.buildIdentityKey(entry.entity, instance, entry.pkColumns);
      this.idMap.identityMap.delete(key);
      this.trackedEntries.delete(instance);
    }

    this.idMap.stateMap.set(instance, EntityState.DETACHED);

    // Cascade detach
    if (this.options.cascade) {
      const entityClass = instance.constructor as ClazzType<any>;
      this.cascade.propagateToRelations(instance, entityClass, (child) => {
        this.detach(child, seen);
      });
    }

    return this;
  }

  /**
   * Merge a detached instance into the buffer.
   * When cascade is enabled, propagates merge to related entities.
   */
  merge(instance: any, visited?: Set<any>): this {
    const seen = visited ?? new Set<any>();
    if (seen.has(instance)) return this;
    seen.add(instance);

    const entityClass = instance.constructor as ClazzType<any>;
    this.idMap.validateEntity(entityClass);
    const { columnNames, pkColumns } = this.idMap.getColumnInfo(entityClass);

    try {
      const key = this.idMap.buildIdentityKey(entityClass, instance, pkColumns);
      const existing = this.idMap.identityMap.get(key);
      if (existing && existing !== instance) {
        for (const col of columnNames) {
          if (instance[col] !== undefined) existing[col] = instance[col];
        }
        // Cascade merge
        if (this.options.cascade) {
          this.cascade.propagateToRelations(instance, entityClass, (child) => {
            try { this.merge(child, seen); } catch (err) {
              // Only swallow "not registered" errors
              if (err instanceof Error && /not.*registered|no.*entity|table.*not/i.test(err.message)) return;
              throw err;
            }
          });
        }
        return this;
      }
    } catch (err) {
      // PK missing → track as new; only swallow identity key errors
      if (!(err instanceof Error && /PK column/.test(err.message))) throw err;
    }

    this.track(instance);

    // Cascade merge
    if (this.options.cascade) {
      this.cascade.propagateToRelations(instance, entityClass, (child) => {
        try { this.merge(child, seen); } catch (err) {
          // Only swallow "not registered" errors
          if (err instanceof Error && /not.*registered|no.*entity|table.*not/i.test(err.message)) return;
          throw err;
        }
      });
    }

    return this;
  }

  /**
   * Refresh a tracked entity from the database.
   * When cascade is enabled, propagates refresh to tracked related entities.
   */
  async refresh(instance: any, visited?: Set<any>): Promise<this> {
    const seen = visited ?? new Set<any>();
    if (seen.has(instance)) return this;
    seen.add(instance);

    const entry = this.trackedEntries.get(instance);
    if (!entry) {
      throw new Error(
        `Cannot refresh: instance of "${instance.constructor.name}" is not tracked.`,
      );
    }

    const where: Record<string, any> = {};
    for (const pk of entry.pkColumns) where[pk] = instance[pk];
    const fresh = await this.ctx.em.findOne(entry.entity, { where: where as any });
    if (!fresh) {
      throw new Error(`Cannot refresh: not found in database.`);
    }

    for (const col of entry.columnNames) {
      instance[col] = (fresh as any)[col];
    }
    entry.snapshot = this.strategy.snapshot(instance, entry.columnNames);

    if (entry.collectionSnapshots) {
      entry.collectionSnapshots = snapshotCollections(instance, entry.entity);
    }

    // Cascade refresh to tracked related entities
    if (this.options.cascade) {
      const entityClass = instance.constructor as ClazzType<any>;
      for (const child of this.cascade.getTrackedRelatedEntities(instance, entityClass, this.trackedEntries)) {
        await this.refresh(child, seen);
      }
    }

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
      const key = this.idMap.buildIdentityKey(entry.entity, instance, entry.pkColumns);
      this.idMap.identityMap.delete(key);
      if (this.options.logging) this.log("untrack", { entity: entry.entity.name, key });
    }
    this.trackedEntries.delete(instance);
    this.idMap.stateMap.set(instance, EntityState.DETACHED);
    return this;
  }

  /**
   * Clear all tracked entities, Identity Map, and queued operations.
   */
  clear(): this {
    this.trackedEntries.clear();
    this.idMap.identityMap.clear();
    this.insertQueue.length = 0;
    this.deleteQueue.length = 0;
    this.persistQueue.length = 0;
    this.bulkUpdateQueue.length = 0;
    this.bulkDeleteQueue.length = 0;
    this.idMap.stateMap.clear();
    return this;
  }

  /**
   * Returns the total count of tracked + queued operations.
   */
  size(): {
    tracked: number; inserts: number; deletes: number; persists: number;
    bulkUpdates: number; bulkDeletes: number;
  } {
    return {
      tracked: this.trackedEntries.size,
      inserts: this.insertQueue.length,
      deletes: this.deleteQueue.length,
      persists: this.persistQueue.length,
      bulkUpdates: this.bulkUpdateQueue.length,
      bulkDeletes: this.bulkDeleteQueue.length,
    };
  }

  /**
   * Preview the operations that will be executed on flush, in execution order.
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
          where: this.idMap.buildPkWhere(entry.instance, entry.pkColumns),
          data: diff,
        });
      }
    }

    // Persists (instance-based inserts)
    for (const entry of this.persistQueue) {
      const data: Record<string, any> = {};
      for (const col of entry.columnNames) {
        if (entry.instance[col] !== undefined) data[col] = entry.instance[col];
      }
      entries.push({
        action: "insert",
        entity: entry.entity.name,
        data,
      });
    }

    // Legacy inserts (plain object)
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

    // Bulk updates
    for (const bu of this.bulkUpdateQueue) {
      entries.push({
        action: "bulkUpdate",
        entity: bu.entity.name,
        where: bu.where,
        set: bu.set,
      });
    }

    // Bulk deletes
    for (const bd of this.bulkDeleteQueue) {
      entries.push({
        action: "bulkDelete",
        entity: bd.entity.name,
        where: bd.where,
      });
    }

    return entries;
  }

  /**
   * Typed changeset — structured version of preview() with entity class references.
   */
  computeChanges(): BufferChangeset {
    const changeset: BufferChangeset = { inserts: [], updates: [], deletes: [] };
    const entities = this.ctx.getEntities();

    // Updates
    for (const entry of this.trackedEntries.values()) {
      const diff = this.strategy.diff(
        entry.instance,
        entry.snapshot,
        entry.columnNames,
        entry.pkColumns,
      );
      if (diff) {
        changeset.updates.push({
          entity: entry.entity,
          data: diff,
          where: this.idMap.buildPkWhere(entry.instance, entry.pkColumns),
          instance: entry.instance,
        });
      }
    }

    // Persists
    const sortedPersists = sortForInsert([...this.persistQueue], entities);
    for (const entry of sortedPersists) {
      const data: Record<string, any> = {};
      for (const col of entry.columnNames) {
        if (entry.instance[col] !== undefined) data[col] = entry.instance[col];
      }
      changeset.inserts.push({ entity: entry.entity, data, instance: entry.instance });
    }

    // Legacy inserts
    for (const insert of this.insertQueue) {
      changeset.inserts.push({ entity: insert.entity, data: insert.data });
    }

    // Deletes
    const sortedDeletes = sortForDelete([...this.deleteQueue], entities);
    for (const del of sortedDeletes) {
      changeset.deletes.push({ entity: del.entity, criteria: del.criteria });
    }

    return changeset;
  }

  /**
   * Execute all pending operations atomically within a transaction.
   * Order: updates → inserts → collection diffs → deletes.
   */
  async flush(): Promise<BufferFlushResult> {
    // No-op if nothing to do. Fast-check queues first to skip expensive diff when possible.
    if (!this.hasQueuedWork() && !this.hasPendingWork()) {
      if (this.options.logging) this.log("flush → no-op (no pending work)");
      return { updates: 0, inserts: 0, deletes: 0 };
    }

    const em = this.ctx.em;
    const result: BufferFlushResult = { updates: 0, inserts: 0, deletes: 0 };
    const entities = this.ctx.getEntities();

    if (this.options.logging) {
      const sz = this.size();
      this.log("flush → begin", {
        tracked: sz.tracked, persists: sz.persists, deletes: sz.deletes,
        inserts: sz.inserts, bulkUpdates: sz.bulkUpdates, bulkDeletes: sz.bulkDeletes,
      });
    }

    // Compute topological index map once for the entire flush
    const indexMap = buildTopologicalIndexMap(entities);

    // Capture queues before flush (for retry on failure)
    const insertsCopy = [...this.insertQueue];
    const deletesCopy = [...this.deleteQueue];
    const persistsCopy = [...this.persistQueue];
    const bulkUpdatesCopy = [...this.bulkUpdateQueue];
    const bulkDeletesCopy = [...this.bulkDeleteQueue];

    try {
      const flushFn = async (txEm: EntityManager) => {
        const visited = new Set<any>();

        // 1. Updates — dirty tracked entities (topological order)
        const sortedTracked = sortByIndex(
          [...this.trackedEntries.values()].filter(
            (e) => !e.readOnly && this.shouldDirtyCheck(e),
          ),
          indexMap,
        );

        if (this.options.batchUpdate) {
          await this.flushExec.flushUpdatesBatched(txEm, sortedTracked, visited, result);
        } else {
          for (const entry of sortedTracked) {
            const diff = this.strategy.diff(
              entry.instance,
              entry.snapshot,
              entry.columnNames,
              entry.pkColumns,
            );
            if (diff) {
              if (this.options.logging) {
                const pk = this.idMap.buildPkWhere(entry.instance, entry.pkColumns);
                this.log("flush: UPDATE (dirty)", { entity: entry.entity.name, pk, changed: Object.keys(diff) });
              }
              await this.flushExec.emitFlushEvent("preUpdate", entry.entity, entry.instance, diff);
              const saveData = this.idMap.extractColumnData(entry.instance, entry.columnNames);
              const updated = await txEm.save(entry.entity, saveData);
              if (updated) {
                for (const col of entry.columnNames) {
                  const freshValue = (updated as any)[col];
                  if (freshValue !== undefined) {
                    entry.instance[col] = freshValue;
                  }
                }
              }
              result.updates++;
              visited.add(entry.instance);
              await this.flushExec.emitFlushEvent("postUpdate", entry.entity, entry.instance, diff);
              await this.cascade.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
            }
          }
        }

        // 2. Persist queue (instance-based inserts — topological order)
        const sortedPersists = sortByIndex([...persistsCopy], indexMap);

        if (this.options.batchInsert && sortedPersists.length > 0) {
          await this.flushExec.flushPersistsBatched(txEm, sortedPersists, visited, result);
        } else {
          for (const entry of sortedPersists) {
            if (this.options.logging) this.log("flush: INSERT", { entity: entry.entity.name });
            await this.flushExec.emitFlushEvent("preInsert", entry.entity, entry.instance);
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
            await this.flushExec.emitFlushEvent("postInsert", entry.entity, entry.instance);
            await this.cascade.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
          }
        }

        // 3. Legacy inserts (plain object)
        for (const insert of insertsCopy) {
          await txEm.save(insert.entity, insert.data);
          result.inserts++;
        }

        // 4. Collection diffs (O2M orphan removal + M2M pivot sync)
        for (const entry of sortedTracked) {
          if (!entry.collectionSnapshots) continue;
          for (const colSnap of entry.collectionSnapshots) {
            const diff = diffCollection(entry.instance, colSnap);
            if (!diff) continue;
            if (colSnap.relationType === "oneToMany") {
              await this.cascade.processOneToManyCollectionDiff(txEm, entry, diff, visited, result);
            } else if (colSnap.relationType === "manyToMany") {
              await this.cascade.processManyToManyCollectionDiff(txEm, entry, diff, result);
            }
          }
        }

        // 5. Cascade delete — before parent delete, cascade-delete children
        if (this.options.cascade) {
          const cascadeDeletes: DeleteEntry[] = [];
          for (const del of deletesCopy) {
            await this.cascade.collectCascadeDeletes(txEm, del.entity, del.criteria, cascadeDeletes, new Set());
          }
          // Add cascade deletes to the list (will be sorted below)
          deletesCopy.push(...cascadeDeletes);
        }

        // 6. Deletes (reverse topological order — children first)
        const sortedDeletes = sortByIndex([...deletesCopy], indexMap, true);
        for (const del of sortedDeletes) {
          if (this.options.logging) this.log("flush: DELETE", { entity: del.entity.name, criteria: del.criteria });
          await this.flushExec.emitFlushEvent("preDelete", del.entity, undefined, undefined, del.criteria);
          await txEm.delete(del.entity, del.criteria);
          result.deletes++;
          await this.flushExec.emitFlushEvent("postDelete", del.entity, undefined, undefined, del.criteria);
        }

        // 7. Bulk UPDATE — sync tracked entries after execution
        for (const bu of bulkUpdatesCopy) {
          await this.flushExec.executeBulkUpdate(txEm, bu);
          result.updates++;
          this.flushExec.syncTrackedAfterBulkUpdate(bu, this.trackedEntries);
        }

        // 8. Bulk DELETE — evict matching tracked entries after execution
        for (const bd of bulkDeletesCopy) {
          await this.flushExec.executeBulkDelete(txEm, bd);
          result.deletes++;
          this.flushExec.evictTrackedAfterBulkDelete(bd, this.trackedEntries);
        }
      };

      // Both nested and top-level flush run inside em.transaction().
      await em.transaction(async (txEm) => {
        if (this.parent) {
          const spName = `sp_nested_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          try {
            await txEm.query(`SAVEPOINT ${spName}`);
            await flushFn(txEm);
          } catch (error) {
            await txEm.query(`ROLLBACK TO SAVEPOINT ${spName}`);
            throw error;
          }
        } else {
          await flushFn(txEm);
        }
      });

      // Success — clear queues
      this.insertQueue.length = 0;
      this.deleteQueue.length = 0;
      this.persistQueue.length = 0;
      this.bulkUpdateQueue.length = 0;
      this.bulkDeleteQueue.length = 0;

      if (this.options.retainAfterFlush) {
        // Re-snapshot tracked entities + clear explicit dirty flags
        for (const entry of this.trackedEntries.values()) {
          entry.snapshot = this.strategy.snapshot(entry.instance, entry.columnNames);
          entry.explicitDirty = false;
          if (entry.collectionSnapshots) {
            entry.collectionSnapshots = snapshotCollections(entry.instance, entry.entity);
          }
        }
        // Persisted instances now have PKs — auto-track them
        for (const entry of persistsCopy) {
          if (!this.trackedEntries.has(entry.instance)) {
            this.track(entry.instance);
          }
          this.idMap.stateMap.set(entry.instance, EntityState.MANAGED);
        }
      } else {
        this.trackedEntries.clear();
        this.idMap.identityMap.clear();
        // Update states for persists
        for (const entry of persistsCopy) {
          this.idMap.stateMap.set(entry.instance, EntityState.MANAGED);
        }
      }

      // Post-flush callback
      if (this.options.onFlush) {
        await this.options.onFlush(result);
      }

      if (this.options.logging) this.log("flush → success", result);

      return result;
    } catch (error) {
      if (this.options.logging) this.log("flush → FAILED (queues restored)", { error: (error as Error).message });
      // On failure, restore queues so the user can retry
      this.insertQueue.length = 0;
      this.insertQueue.push(...insertsCopy);
      this.deleteQueue.length = 0;
      this.deleteQueue.push(...deletesCopy);
      this.persistQueue.length = 0;
      this.persistQueue.push(...persistsCopy);
      this.bulkUpdateQueue.length = 0;
      this.bulkUpdateQueue.push(...bulkUpdatesCopy);
      this.bulkDeleteQueue.length = 0;
      this.bulkDeleteQueue.push(...bulkDeletesCopy);
      throw error;
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  private resolveIdentity(entityClass: ClazzType<any>, instance: any): any {
    const { pkColumns } = this.idMap.getColumnInfo(entityClass);
    const key = this.idMap.buildIdentityKey(entityClass, instance, pkColumns);

    const existing = this.idMap.identityMap.get(key);
    if (existing) {
      return existing;
    }

    this.track(instance);
    this.lazyInjector.injectLazyRelations(instance, entityClass);
    return instance;
  }

  /**
   * Fast check: are there any queued operations (no diff computation)?
   * Used by flush() to avoid expensive dirty-checking when queues are empty.
   */
  private hasQueuedWork(): boolean {
    return this.insertQueue.length > 0
      || this.deleteQueue.length > 0
      || this.persistQueue.length > 0
      || this.bulkUpdateQueue.length > 0
      || this.bulkDeleteQueue.length > 0;
  }

  /**
   * Check if there is any pending work. Merged loop for tracked entries
   * and collection snapshots with early exit on first dirty finding.
   */
  private hasPendingWork(): boolean {
    if (this.hasQueuedWork()) return true;
    // Single loop: check both column diffs and collection diffs per entry
    for (const entry of this.trackedEntries.values()) {
      if (entry.readOnly) continue;
      if (this.shouldDirtyCheck(entry)) {
        const diff = this.strategy.diff(
          entry.instance,
          entry.snapshot,
          entry.columnNames,
          entry.pkColumns,
        );
        if (diff) return true;
      }
      if (entry.collectionSnapshots) {
        for (const colSnap of entry.collectionSnapshots) {
          if (diffCollection(entry.instance, colSnap)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Should this entry be dirty-checked? Respects change tracking policy.
   */
  private shouldDirtyCheck(entry: TrackedEntry): boolean {
    if (this.changeTracking === ChangeTrackingPolicy.DEFERRED_EXPLICIT) {
      return entry.explicitDirty === true;
    }
    return true; // DEFERRED_IMPLICIT — always check
  }

  /**
   * Auto-flush if the current flush mode requires it.
   */
  private async autoFlushIfNeeded(): Promise<void> {
    if (this.flushMode === FlushMode.AUTO || this.flushMode === FlushMode.ALWAYS) {
      if (this.flushMode === FlushMode.ALWAYS || this.hasPendingWork()) {
        if (this.options.logging) this.log("auto-flush triggered", { mode: this.flushMode });
        await this.flush();
      }
    }
  }

  /** Structured console log for buffer lifecycle events. */
  private log(action: string, detail?: Record<string, any>): void {
    const ts = new Date().toISOString();
    const extra = detail ? " " + JSON.stringify(detail) : "";
    console.log(`${ts} [WriteBuffer] ${action}${extra}`);
  }
}
