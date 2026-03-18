/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import { ColumnMetadata } from "../../../scanner/ColumnScanner";
import { ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../../../decorators/OneToMany";
import { MANY_TO_ONE_TOKEN } from "../../../decorators/ManyToOne";
import { ONE_TO_ONE_TOKEN } from "../../../decorators/OneToOne";
import { MANY_TO_MANY_TOKEN } from "../../../decorators/ManyToMany";
import { ENTITY_TOKEN } from "../../../decorators/Entity";
import { hasCascade } from "../../../types/CascadeType";
import { FindOption } from "../../../dialects/FindOption";
import { PluginContext } from "../PluginContext";
import { TrackedEntry, InsertEntry, DeleteEntry, PersistEntry } from "./BufferEntry";
import {
  BufferPreviewEntry, BufferFlushResult, BufferPluginOptions, BufferChangeset,
  ChangeTrackingPolicy, FlushMode,
  FlushEventType, FlushEvent, FlushEventListener,
  BulkUpdateEntry, BulkDeleteEntry,
} from "./BufferPreview";
import { BufferStrategy, SnapshotStrategy } from "./BufferStrategy";
import { EntityState } from "./EntityUnitState";
import { sortForInsert, sortForDelete } from "./DependencyGraph";
import { snapshotCollections, diffCollection, CollectionDiff } from "./CollectionTracker";
import { createPersistentCollection } from "./PersistentCollection";
import { injectLazyProxy } from "../../LazyLoader";
import type { EntityManager } from "../../EntityManager";
import type { ManyToOneMetadata } from "../../../decorators/ManyToOne";
import type { OneToOneMetadata } from "../../../decorators/OneToOne";
import type { ManyToManyMetadata } from "../../../decorators/ManyToMany";

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
  private readonly persistQueue: PersistEntry[] = [];
  private readonly bulkUpdateQueue: BulkUpdateEntry[] = [];
  private readonly bulkDeleteQueue: BulkDeleteEntry[] = [];
  private readonly strategy: BufferStrategy;
  private readonly ctx: PluginContext;
  private readonly options: Required<BufferPluginOptions>;
  private readonly stateMap = new Map<any, EntityState>();
  private readonly flushMode: FlushMode;
  private readonly changeTracking: ChangeTrackingPolicy;
  private readonly flushListeners = new Map<FlushEventType, FlushEventListener[]>();
  /** Parent buffer for nested UoW (savepoint) */
  private readonly parent?: WriteBuffer;

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
    };
    this.flushMode = this.options.flushMode;
    this.changeTracking = this.options.changeTracking;
  }

  // ── Entity State ─────────────────────────────────────────────

  /**
   * Returns the current lifecycle state of an entity instance.
   */
  getState(instance: any): EntityState {
    return this.stateMap.get(instance) ?? EntityState.DETACHED;
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
    const collectionSnapshots = snapshotCollections(instance, entityClass);

    this.trackedEntries.set(instance, {
      entity: entityClass,
      instance,
      snapshot,
      columnNames,
      pkColumns,
      collectionSnapshots: collectionSnapshots.length > 0 ? collectionSnapshots : undefined,
    });
    this.identityMap.set(key, instance);
    this.stateMap.set(instance, EntityState.MANAGED);

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
    await this.autoFlushIfNeeded();
    const result = await this.ctx.em.findOne(entity, option);
    if (result === null) return null;
    const tracked = this.resolveIdentity(entity, result) as T;
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
    this.validateEntity(entityClass);
    const { pkColumns } = this.getColumnInfo(entityClass);

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
    const key = this.buildIdentityKey(entityClass, instance, pkColumns);
    const existing = this.identityMap.get(key);
    if (existing) return existing as T;

    // Register in identity map (not snapshot-tracked — reference only)
    this.identityMap.set(key, instance);
    this.stateMap.set(instance, EntityState.MANAGED);

    // Inject lazy proxies for relation properties
    this.injectLazyRelations(instance, entityClass);

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
    this.validateEntity(entity);
    this.bulkUpdateQueue.push({ entity, where: options.where, set: options.set });
    return this;
  }

  /**
   * Queue a bulk DELETE operation.
   * Executes `DELETE FROM table WHERE ...` during flush.
   */
  deleteMany<T>(entity: ClazzType<T>, where: Record<string, any>): this {
    this.validateEntity(entity);
    this.bulkDeleteQueue.push({ entity, where });
    return this;
  }

  // ── Flush Events ───────────────────────────────────────────────

  /**
   * Register a per-entity flush event listener.
   *
   * @example
   * ```ts
   * buf.onFlushEvent("preUpdate", (event) => {
   *   console.log(`Updating ${event.entity.name}`, event.data);
   * });
   * ```
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
   *
   * The nested buffer shares the parent's identity map references but
   * maintains its own tracking state. On flush(), the nested buffer
   * wraps its operations in a SAVEPOINT within the parent's transaction.
   *
   * On success, tracked entities are merged back to the parent buffer.
   * On failure, only the nested buffer's changes are rolled back.
   */
  beginNested(): WriteBuffer {
    return new WriteBuffer(this.ctx, this.options, this);
  }

  // ── Persistent Collections ─────────────────────────────────────

  /**
   * Wrap an entity's collection property with a PersistentCollection proxy.
   * When the array is mutated (push/splice/index set/etc.), the parent
   * entity is automatically marked as dirty.
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
   * Register an entity instance for insertion.
   *
   * - If the instance already has a PK, delegates to track() for dirty checking.
   * - If the instance has no PK (new entity), queues it for INSERT on flush().
   *   After flush, the generated PK and auto-columns are written back to the
   *   original instance reference.
   */
  persist(instance: any): this {
    const entityClass = instance.constructor as ClazzType<any>;
    this.validateEntity(entityClass);
    const { columnNames, pkColumns } = this.getColumnInfo(entityClass);

    const hasPk = pkColumns.every(pk => {
      const v = instance[pk];
      return v !== undefined && v !== null;
    });

    if (hasPk) return this.track(instance);

    // Idempotent — same reference
    if (this.persistQueue.some(e => e.instance === instance)) return this;

    this.persistQueue.push({ entity: entityClass, instance, columnNames, pkColumns });
    this.stateMap.set(instance, EntityState.NEW);
    return this;
  }

  /**
   * Mark an entity instance for deletion.
   *
   * - If the instance is tracked, untracks it first.
   * - If the instance is in the persistQueue (not yet flushed), removes it
   *   without adding to deleteQueue (cancel the pending INSERT).
   * - Otherwise, queues a DELETE using the instance's PK values.
   *
   * Throws if the instance has no PK assigned.
   */
  remove(instance: any): this {
    const entityClass = instance.constructor as ClazzType<any>;
    this.validateEntity(entityClass);
    const { pkColumns } = this.getColumnInfo(entityClass);

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
      this.stateMap.set(instance, EntityState.DETACHED);
      return this;
    }

    this.deleteQueue.push({ entity: entityClass, criteria });
    this.stateMap.set(instance, EntityState.REMOVED);
    return this;
  }

  /**
   * Detach an entity from the buffer entirely.
   * Removes from tracking, Identity Map, persist queue, and sets state to DETACHED.
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
      const key = this.buildIdentityKey(entry.entity, instance, entry.pkColumns);
      this.identityMap.delete(key);
      this.trackedEntries.delete(instance);
    }

    this.stateMap.set(instance, EntityState.DETACHED);

    // Cascade detach
    if (this.options.cascade) {
      const entityClass = instance.constructor as ClazzType<any>;
      this.propagateToRelations(instance, entityClass, (child) => {
        this.detach(child, seen);
      });
    }

    return this;
  }

  /**
   * Merge a detached instance into the buffer.
   * If an instance with the same PK is already tracked, copies column values
   * from the provided instance onto the existing tracked instance.
   * If no existing instance is found, tracks the provided instance.
   * When cascade is enabled, propagates merge to related entities.
   */
  merge(instance: any, visited?: Set<any>): this {
    const seen = visited ?? new Set<any>();
    if (seen.has(instance)) return this;
    seen.add(instance);

    const entityClass = instance.constructor as ClazzType<any>;
    this.validateEntity(entityClass);
    const { columnNames, pkColumns } = this.getColumnInfo(entityClass);

    try {
      const key = this.buildIdentityKey(entityClass, instance, pkColumns);
      const existing = this.identityMap.get(key);
      if (existing && existing !== instance) {
        for (const col of columnNames) {
          if (instance[col] !== undefined) existing[col] = instance[col];
        }
        // Cascade merge
        if (this.options.cascade) {
          this.propagateToRelations(instance, entityClass, (child) => {
            try { this.merge(child, seen); } catch { /* skip unregistered */ }
          });
        }
        return this;
      }
    } catch {
      // PK missing → track as new
    }

    this.track(instance);

    // Cascade merge
    if (this.options.cascade) {
      this.propagateToRelations(instance, entityClass, (child) => {
        try { this.merge(child, seen); } catch { /* skip unregistered */ }
      });
    }

    return this;
  }

  /**
   * Refresh a tracked entity from the database.
   * Reloads column values and re-takes the snapshot, making the entity clean.
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
      for (const child of this.getTrackedRelatedEntities(instance, entityClass)) {
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
      const key = this.buildIdentityKey(entry.entity, instance, entry.pkColumns);
      this.identityMap.delete(key);
    }
    this.trackedEntries.delete(instance);
    this.stateMap.set(instance, EntityState.DETACHED);
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
    this.persistQueue.length = 0;
    this.bulkUpdateQueue.length = 0;
    this.bulkDeleteQueue.length = 0;
    this.stateMap.clear();
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
          where: this.buildPkWhere(entry),
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
    // No-op if nothing to do (avoids unnecessary diff computation)
    if (!this.hasPendingWork()) {
      return { updates: 0, inserts: 0, deletes: 0 };
    }

    const em = this.ctx.em;
    const result: BufferFlushResult = { updates: 0, inserts: 0, deletes: 0 };
    const entities = this.ctx.getEntities();

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
        const sortedTracked = sortForInsert(
          [...this.trackedEntries.values()].filter(
            (e) => !e.readOnly && this.shouldDirtyCheck(e),
          ),
          entities,
        );

        if (this.options.batchUpdate) {
          await this.flushUpdatesBatched(txEm, sortedTracked, visited, result);
        } else {
          for (const entry of sortedTracked) {
            const diff = this.strategy.diff(
              entry.instance,
              entry.snapshot,
              entry.columnNames,
              entry.pkColumns,
            );
            if (diff) {
              await this.emitFlushEvent("preUpdate", entry.entity, entry.instance, diff);
              const saveData = this.extractColumnData(entry.instance, entry.columnNames);
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
              await this.emitFlushEvent("postUpdate", entry.entity, entry.instance, diff);
              await this.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
            }
          }
        }

        // 2. Persist queue (instance-based inserts — topological order)
        const sortedPersists = sortForInsert([...persistsCopy], entities);

        if (this.options.batchInsert && sortedPersists.length > 0) {
          await this.flushPersistsBatched(txEm, sortedPersists, visited, result);
        } else {
          for (const entry of sortedPersists) {
            await this.emitFlushEvent("preInsert", entry.entity, entry.instance);
            const saveData = this.extractColumnData(entry.instance, entry.columnNames);
            const saved = await txEm.save(entry.entity, saveData);
            if (saved) {
              for (const col of entry.columnNames) {
                const v = (saved as any)[col];
                if (v !== undefined) entry.instance[col] = v;
              }
            }
            result.inserts++;
            visited.add(entry.instance);
            await this.emitFlushEvent("postInsert", entry.entity, entry.instance);
            await this.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
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
              await this.processOneToManyCollectionDiff(txEm, entry, diff, visited, result);
            } else if (colSnap.relationType === "manyToMany") {
              await this.processManyToManyCollectionDiff(txEm, entry, diff, result);
            }
          }
        }

        // 5. Cascade delete — before parent delete, cascade-delete children
        if (this.options.cascade) {
          const cascadeDeletes: DeleteEntry[] = [];
          for (const del of deletesCopy) {
            await this.collectCascadeDeletes(txEm, del.entity, del.criteria, cascadeDeletes, new Set());
          }
          // Add cascade deletes to the list (will be sorted below)
          deletesCopy.push(...cascadeDeletes);
        }

        // 6. Deletes (reverse topological order — children first)
        const sortedDeletes = sortForDelete([...deletesCopy], entities);
        for (const del of sortedDeletes) {
          await this.emitFlushEvent("preDelete", del.entity, undefined, undefined, del.criteria);
          await txEm.delete(del.entity, del.criteria);
          result.deletes++;
          await this.emitFlushEvent("postDelete", del.entity, undefined, undefined, del.criteria);
        }

        // 7. Bulk UPDATE — sync tracked entries after execution
        for (const bu of bulkUpdatesCopy) {
          await this.executeBulkUpdate(txEm, bu);
          result.updates++;
          this.syncTrackedAfterBulkUpdate(bu);
        }

        // 8. Bulk DELETE — evict matching tracked entries after execution
        for (const bd of bulkDeletesCopy) {
          await this.executeBulkDelete(txEm, bd);
          result.deletes++;
          this.evictTrackedAfterBulkDelete(bd);
        }
      };

      // Both nested and top-level flush run inside em.transaction().
      // For nested UoW, a SAVEPOINT is created inside the transaction
      // so that it runs on the same connection as the parent.
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
          this.stateMap.set(entry.instance, EntityState.MANAGED);
        }
      } else {
        this.trackedEntries.clear();
        this.identityMap.clear();
        // Update states for persists
        for (const entry of persistsCopy) {
          this.stateMap.set(entry.instance, EntityState.MANAGED);
        }
      }

      // Post-flush callback
      if (this.options.onFlush) {
        await this.options.onFlush(result);
      }

      return result;
    } catch (error) {
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
    const { pkColumns } = this.getColumnInfo(entityClass);
    const key = this.buildIdentityKey(entityClass, instance, pkColumns);

    const existing = this.identityMap.get(key);
    if (existing) {
      return existing;
    }

    this.track(instance);
    this.injectLazyRelations(instance, entityClass);
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
    if (this.insertQueue.length > 0 || this.deleteQueue.length > 0 || this.persistQueue.length > 0) {
      return true;
    }
    if (this.bulkUpdateQueue.length > 0 || this.bulkDeleteQueue.length > 0) {
      return true;
    }
    for (const entry of this.trackedEntries.values()) {
      if (entry.readOnly) continue;
      if (!this.shouldDirtyCheck(entry)) continue;
      const diff = this.strategy.diff(
        entry.instance,
        entry.snapshot,
        entry.columnNames,
        entry.pkColumns,
      );
      if (diff) return true;
    }
    // Check collection diffs
    for (const entry of this.trackedEntries.values()) {
      if (entry.readOnly) continue;
      if (!entry.collectionSnapshots) continue;
      for (const colSnap of entry.collectionSnapshots) {
        if (diffCollection(entry.instance, colSnap)) return true;
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
        await this.flush();
      }
    }
  }

  /**
   * Apply a pessimistic lock to a tracked entity for acquisition during flush.
   */
  private buildPkWhere(entry: TrackedEntry): Record<string, any> {
    const where: Record<string, any> = {};
    for (const pk of entry.pkColumns) {
      where[pk] = entry.instance[pk];
    }
    return where;
  }

  /**
   * Extract only column values from an instance (no relation properties).
   * This ensures CascadeHandler in em.save() won't fire — WriteBuffer
   * handles cascade directly.
   */
  private extractColumnData(
    instance: any,
    columnNames: string[],
  ): Record<string, any> {
    const data: Record<string, any> = {};
    for (const col of columnNames) {
      if (instance[col] !== undefined) data[col] = instance[col];
    }
    return data;
  }

  /**
   * Process cascade insert/update for @OneToMany, @OneToOne, and @ManyToMany relations.
   */
  private async processCascadeInsertUpdate(
    txEm: EntityManager,
    entityClass: ClazzType<any>,
    instance: any,
    visited: Set<any>,
    result: BufferFlushResult,
  ): Promise<void> {
    if (!this.options.cascade) return;

    // ── @OneToMany cascade ──
    const oneToManyMeta: OneToManyMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_MANY_TOKEN, entityClass) ?? [];

    for (const rel of oneToManyMeta) {
      if (!hasCascade(rel.cascade, "insert") && !hasCascade(rel.cascade, "update")) continue;

      const children = instance[rel.propertyKey];
      if (!Array.isArray(children) || children.length === 0) continue;

      const ChildEntity = rel.getRelatedEntity();
      const fkColumn = this.resolveFkColumn(rel, ChildEntity);
      const parentPk = this.getParentPkValue(instance, entityClass);

      for (const child of children) {
        if (visited.has(child)) continue;
        visited.add(child);

        child[fkColumn] = parentPk;

        const childInfo = this.getColumnInfo(ChildEntity);
        const childData: Record<string, any> = {};
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

    // ── @OneToOne cascade (owning side — has joinColumn) ──
    const oneToOneMeta: any[] =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ?? [];

    for (const rel of oneToOneMeta) {
      const cascade = rel.option?.cascade;
      if (!hasCascade(cascade, "insert") && !hasCascade(cascade, "update")) continue;

      const related = instance[rel.propertyKey];
      if (!related || visited.has(related)) continue;
      visited.add(related);

      const RelatedEntity = rel.getRelatedEntity();
      const relatedInfo = this.getColumnInfo(RelatedEntity);
      const relatedData: Record<string, any> = {};
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
        const relatedPk = this.getParentPkValue(related, RelatedEntity);
        instance[rel.joinColumn] = relatedPk;
      }

      await this.processCascadeInsertUpdate(txEm, RelatedEntity, related, visited, result);
    }

    // ── @ManyToMany cascade persist (owning side — has joinTable, no mappedBy) ──
    const manyToManyMeta: any[] =
      Reflect.getMetadata(MANY_TO_MANY_TOKEN, entityClass) ?? [];

    for (const rel of manyToManyMeta) {
      if (rel.mappedBy || !rel.joinTable) continue; // skip inverse side

      const children = instance[rel.propertyKey];
      if (!Array.isArray(children) || children.length === 0) continue;

      const RelatedEntity = rel.getRelatedEntity();
      const relatedPkColumns = this.getColumnInfo(RelatedEntity).pkColumns;
      const parentPk = this.getParentPkValue(instance, entityClass);

      for (const child of children) {
        // Only cascade-persist NEW children (no PK)
        const hasPk = relatedPkColumns.every((pk: string) => {
          const v = child[pk];
          return v !== undefined && v !== null;
        });

        if (!hasPk && !visited.has(child)) {
          visited.add(child);
          const childInfo = this.getColumnInfo(RelatedEntity);
          const childData: Record<string, any> = {};
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
  private async processOneToManyCollectionDiff(
    txEm: EntityManager,
    parentEntry: TrackedEntry,
    diff: CollectionDiff,
    visited: Set<any>,
    result: BufferFlushResult,
  ): Promise<void> {
    const { snapshot } = diff;
    const parentPk = this.getParentPkValue(parentEntry.instance, parentEntry.entity);

    // Added children — cascade insert if cascade includes insert
    if (this.options.cascade && hasCascade(snapshot.cascade, "insert")) {
      for (const child of diff.added) {
        if (visited.has(child)) continue;
        visited.add(child);

        if (snapshot.fkColumn) {
          child[snapshot.fkColumn] = parentPk;
        }

        const ChildEntity = snapshot.relatedEntity;
        const childInfo = this.getColumnInfo(ChildEntity);
        const childData: Record<string, any> = {};
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

    // Removed children — orphan removal if enabled
    if (this.options.orphanRemoval) {
      const ChildEntity = snapshot.relatedEntity;
      const childInfo = this.getColumnInfo(ChildEntity);
      for (const child of diff.removed) {
        const criteria: Record<string, any> = {};
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
  private async processManyToManyCollectionDiff(
    txEm: EntityManager,
    parentEntry: TrackedEntry,
    diff: CollectionDiff,
    result: BufferFlushResult,
  ): Promise<void> {
    if (!this.options.manyToManySync) return;

    const { snapshot } = diff;
    if (!snapshot.joinTable) return;

    const { name: tableName, joinColumn, inverseJoinColumn } = snapshot.joinTable;
    const parentPk = this.getParentPkValue(parentEntry.instance, parentEntry.entity);
    const childPkColumns = this.getColumnInfo(snapshot.relatedEntity).pkColumns;

    const wrappedTable = this.ctx.wrapTable(tableName);
    const wrappedJoinCol = this.ctx.wrap(joinColumn);
    const wrappedInverseCol = this.ctx.wrap(inverseJoinColumn);

    // Added items → INSERT into pivot table
    for (const child of diff.added) {
      const childPk = childPkColumns.length === 1 ? child[childPkColumns[0]] : null;
      if (childPk == null) continue;
      const sql = `INSERT INTO ${wrappedTable} (${wrappedJoinCol}, ${wrappedInverseCol}) VALUES (?, ?)`;
      await txEm.query(sql, [parentPk, childPk]);
      result.inserts++;
    }

    // Removed items → DELETE from pivot table
    for (const child of diff.removed) {
      const childPk = childPkColumns.length === 1 ? child[childPkColumns[0]] : null;
      if (childPk == null) continue;
      const sql = `DELETE FROM ${wrappedTable} WHERE ${wrappedJoinCol} = ? AND ${wrappedInverseCol} = ?`;
      await txEm.query(sql, [parentPk, childPk]);
      result.deletes++;
    }
  }

  /**
   * Batch INSERT for multiple entities of the same type.
   * Groups by entity class, builds multi-row INSERT, writes back generated PKs.
   */
  private async flushPersistsBatched(
    txEm: EntityManager,
    persists: PersistEntry[],
    visited: Set<any>,
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
      // Composite PK or single entry → fallback to individual saves
      if (entries.length === 1 || entries[0].pkColumns.length > 1) {
        for (const entry of entries) {
          const saveData = this.extractColumnData(entry.instance, entry.columnNames);
          const saved = await txEm.save(entry.entity, saveData);
          if (saved) {
            for (const col of entry.columnNames) {
              const v = (saved as any)[col];
              if (v !== undefined) entry.instance[col] = v;
            }
          }
          result.inserts++;
          visited.add(entry.instance);
          await this.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
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
        await this.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
      }
    }
  }

  /**
   * Resolve the FK column name on the child entity for a given @OneToMany relation.
   * Reads @ManyToOne metadata from the child to find the joinColumn.
   */
  private resolveFkColumn(
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

  /**
   * Get the PK value(s) of a parent entity instance.
   */
  private getParentPkValue(
    instance: any,
    entityClass: ClazzType<any>,
  ): any {
    const { pkColumns } = this.getColumnInfo(entityClass);
    if (pkColumns.length === 1) return instance[pkColumns[0]];
    const pk: Record<string, any> = {};
    for (const col of pkColumns) pk[col] = instance[col];
    return pk;
  }

  /**
   * Collect cascade delete entries by walking O2M and O2O relations
   * that have cascade: "delete" or cascade: true.
   */
  private async collectCascadeDeletes(
    txEm: EntityManager,
    entityClass: ClazzType<any>,
    criteria: Record<string, any>,
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
      const fkColumn = this.resolveFkColumn(rel, ChildEntity);
      const { pkColumns: parentPks } = this.getColumnInfo(entityClass);

      // Build child criteria from parent PK
      const childCriteria: Record<string, any> = {};
      if (parentPks.length === 1) {
        childCriteria[fkColumn] = criteria[parentPks[0]];
      }

      if (Object.keys(childCriteria).length > 0 && childCriteria[fkColumn] != null) {
        // Recurse into child's children first
        // Load child PKs to build individual criteria for recursive cascade
        const childPkCols = this.getColumnInfo(ChildEntity).pkColumns;
        try {
          const children = await txEm.find(ChildEntity, { where: childCriteria as any });
          for (const child of children) {
            const grandChildCriteria: Record<string, any> = {};
            for (const pk of childPkCols) grandChildCriteria[pk] = (child as any)[pk];
            await this.collectCascadeDeletes(txEm, ChildEntity, grandChildCriteria, out, visited);
          }
        } catch {
          // If find fails (e.g., table not found in test), skip recursive cascade
        }

        out.push({ entity: ChildEntity, criteria: childCriteria });
      }
    }

    // O2O cascade delete (owning side — has joinColumn)
    const o2oMeta: any[] =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ?? [];

    for (const rel of o2oMeta) {
      if (!hasCascade(rel.option?.cascade, "delete")) continue;

      const RelatedEntity = rel.getRelatedEntity();
      const relatedPkCols = this.getColumnInfo(RelatedEntity).pkColumns;

      // If we have the FK value, build criteria for the related entity
      if (rel.joinColumn && criteria[rel.joinColumn] != null) {
        const relCriteria: Record<string, any> = {};
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
  private propagateToRelations(
    instance: any,
    entityClass: ClazzType<any>,
    callback: (child: any) => void,
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
   * Only returns entities that are already tracked in this buffer.
   */
  private getTrackedRelatedEntities(
    instance: any,
    entityClass: ClazzType<any>,
  ): any[] {
    const related: any[] = [];

    this.propagateToRelations(instance, entityClass, (child) => {
      if (this.trackedEntries.has(child)) {
        related.push(child);
      }
    });

    return related;
  }

  /**
   * Batch UPDATE for multiple dirty entities of the same type.
   * Uses CASE WHEN pk = ? THEN ? END expressions per changed column.
   */
  private async flushUpdatesBatched(
    txEm: EntityManager,
    sortedTracked: TrackedEntry[],
    visited: Set<any>,
    result: BufferFlushResult,
  ): Promise<void> {
    // Collect dirty entries
    const dirtyEntries: { entry: TrackedEntry; diff: Record<string, any> }[] = [];
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
    const groups = new Map<ClazzType<any>, { entry: TrackedEntry; diff: Record<string, any> }[]>();
    for (const item of dirtyEntries) {
      let arr = groups.get(item.entry.entity);
      if (!arr) {
        arr = [];
        groups.set(item.entry.entity, arr);
      }
      arr.push(item);
    }

    for (const [entityClass, items] of groups) {
      // Single item or composite PK → fallback to individual save
      if (items.length === 1 || items[0].entry.pkColumns.length > 1) {
        for (const { entry } of items) {
          const saveData = this.extractColumnData(entry.instance, entry.columnNames);
          const updated = await txEm.save(entry.entity, saveData);
          if (updated) {
            for (const col of entry.columnNames) {
              const freshValue = (updated as any)[col];
              if (freshValue !== undefined) entry.instance[col] = freshValue;
            }
          }
          result.updates++;
          visited.add(entry.instance);
          await this.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
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
        await this.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result);
      }
    }
  }

  // ── Flush Events ────────────────────────────────────────────────

  /**
   * Emit a flush event to registered listeners.
   */
  private async emitFlushEvent(
    type: FlushEventType,
    entity: ClazzType<any>,
    instance?: any,
    data?: Record<string, any>,
    criteria?: Record<string, any>,
  ): Promise<void> {
    const listeners = this.flushListeners.get(type);
    if (!listeners || listeners.length === 0) return;
    const event: FlushEvent = { type, entity, instance, data, criteria };
    for (const listener of listeners) {
      await listener(event);
    }
  }

  // ── Bulk DML ───────────────────────────────────────────────────

  /**
   * Execute a bulk UPDATE statement.
   */
  private async executeBulkUpdate(
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
  private async executeBulkDelete(
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
  private syncTrackedAfterBulkUpdate(entry: BulkUpdateEntry): void {
    for (const tracked of this.trackedEntries.values()) {
      if (tracked.entity !== entry.entity) continue;
      if (!this.matchesWhere(tracked.instance, entry.where)) continue;
      for (const [col, val] of Object.entries(entry.set)) {
        tracked.instance[col] = val;
      }
      tracked.snapshot = this.strategy.snapshot(tracked.instance, tracked.columnNames);
    }
  }

  /**
   * After a bulk DELETE, evict tracked instances that match the WHERE clause
   * from identityMap, trackedEntries, and stateMap.
   */
  private evictTrackedAfterBulkDelete(entry: BulkDeleteEntry): void {
    const toEvict: any[] = [];
    for (const tracked of this.trackedEntries.values()) {
      if (tracked.entity !== entry.entity) continue;
      if (!this.matchesWhere(tracked.instance, entry.where)) continue;
      toEvict.push(tracked.instance);
    }
    for (const instance of toEvict) {
      this.trackedEntries.delete(instance);
      this.stateMap.set(instance, EntityState.DETACHED);
      // Remove from identityMap
      const tracked = this.trackedEntries.get(instance);
      // Instance already removed from trackedEntries; scan identityMap
      for (const [key, val] of this.identityMap.entries()) {
        if (val === instance) {
          this.identityMap.delete(key);
          break;
        }
      }
    }
  }

  /**
   * Check if an entity instance matches a simple WHERE clause (equality check).
   */
  private matchesWhere(instance: any, where: Record<string, any>): boolean {
    for (const [col, val] of Object.entries(where)) {
      if (instance[col] !== val) return false;
    }
    return true;
  }

  // ── Proxy Lazy Loading ─────────────────────────────────────────

  /**
   * Inject lazy-loading proxies on unloaded relation properties.
   *
   * When a proxied property is accessed:
   * - First access returns a Promise that loads from DB.
   * - After resolution, the property is replaced with the actual value.
   * - Loaded entities are registered in this buffer's Identity Map.
   *
   * Supports: @ManyToOne, @OneToMany, @OneToOne, @ManyToMany
   */
  private injectLazyRelations(instance: any, entityClass: ClazzType<any>): void {
    this.injectLazyManyToOne(instance, entityClass);
    this.injectLazyOneToMany(instance, entityClass);
    this.injectLazyOneToOne(instance, entityClass);
    this.injectLazyManyToMany(instance, entityClass);
  }

  /**
   * @ManyToOne lazy: access `instance.author` → loads Author by FK value.
   */
  private injectLazyManyToOne(instance: any, entityClass: ClazzType<any>): void {
    const meta: ManyToOneMetadata<any>[] =
      Reflect.getMetadata(MANY_TO_ONE_TOKEN, entityClass) ?? [];

    for (const rel of meta) {
      // Skip if already loaded (not undefined)
      if (instance[rel.columnName] !== undefined) continue;

      // FK column: explicit joinColumn or fallback to columnName
      const fkProp = rel.joinColumn ?? rel.columnName;
      const fkValue = instance[fkProp];
      if (fkValue === undefined || fkValue === null) continue;

      const RelatedEntity = rel.getMappingEntity() as any as ClazzType<any>;
      try { this.validateEntity(RelatedEntity); } catch { continue; }

      const relatedPkCols = this.getColumnInfo(RelatedEntity).pkColumns;
      const refColumn = rel.references ?? (relatedPkCols.length === 1 ? relatedPkCols[0] : null);
      if (!refColumn) continue;

      injectLazyProxy(instance, rel.columnName, async () => {
        const result = await this.ctx.em.findOne(RelatedEntity, {
          where: { [refColumn]: fkValue } as any,
        });
        if (result) return this.resolveIdentity(RelatedEntity, result);
        return undefined;
      });
    }
  }

  /**
   * @OneToMany lazy: access `instance.comments` → loads Comment[] by FK.
   */
  private injectLazyOneToMany(instance: any, entityClass: ClazzType<any>): void {
    const meta: OneToManyMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_MANY_TOKEN, entityClass) ?? [];

    for (const rel of meta) {
      if (instance[rel.propertyKey] !== undefined) continue;

      const ChildEntity = rel.getRelatedEntity();
      try { this.validateEntity(ChildEntity); } catch { continue; }

      const fkColumn = this.resolveFkColumn(rel, ChildEntity);
      const parentPk = this.getParentPkValue(instance, entityClass);
      if (parentPk === undefined || parentPk === null) continue;

      this.injectLazyCollectionProxy(instance, rel.propertyKey, ChildEntity, {
        [fkColumn]: parentPk,
      });
    }
  }

  /**
   * @OneToOne lazy: access `instance.profile` → loads Profile by FK or inverse lookup.
   */
  private injectLazyOneToOne(instance: any, entityClass: ClazzType<any>): void {
    const meta: OneToOneMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ?? [];

    for (const rel of meta) {
      if (instance[rel.propertyKey] !== undefined) continue;

      const RelatedEntity = rel.getRelatedEntity();
      try { this.validateEntity(RelatedEntity); } catch { continue; }

      if (rel.joinColumn) {
        // Owning side — FK column on this entity
        const fkValue = instance[rel.joinColumn];
        if (fkValue === undefined || fkValue === null) continue;

        const relatedPkCols = this.getColumnInfo(RelatedEntity).pkColumns;
        if (relatedPkCols.length !== 1) continue;

        injectLazyProxy(instance, rel.propertyKey, async () => {
          const result = await this.ctx.em.findOne(RelatedEntity, {
            where: { [relatedPkCols[0]]: fkValue } as any,
          });
          if (result) return this.resolveIdentity(RelatedEntity, result);
          return undefined;
        });
      } else if (rel.inverseSide) {
        // Inverse side — find where owning side references our PK
        const parentPk = this.getParentPkValue(instance, entityClass);
        if (parentPk === undefined || parentPk === null) continue;

        const owningMeta: OneToOneMetadata<any>[] =
          Reflect.getMetadata(ONE_TO_ONE_TOKEN, RelatedEntity) ?? [];
        const owningRel = owningMeta.find(
          (r) => r.propertyKey === rel.inverseSide,
        );
        if (!owningRel?.joinColumn) continue;

        injectLazyProxy(instance, rel.propertyKey, async () => {
          const result = await this.ctx.em.findOne(RelatedEntity, {
            where: { [owningRel.joinColumn!]: parentPk } as any,
          });
          if (result) return this.resolveIdentity(RelatedEntity, result);
          return undefined;
        });
      }
    }
  }

  /**
   * @ManyToMany lazy: access `instance.tags` → queries pivot table + loads related entities.
   */
  private injectLazyManyToMany(instance: any, entityClass: ClazzType<any>): void {
    const meta: ManyToManyMetadata<any>[] =
      Reflect.getMetadata(MANY_TO_MANY_TOKEN, entityClass) ?? [];

    for (const rel of meta) {
      if (instance[rel.propertyKey] !== undefined) continue;

      const RelatedEntity = rel.getRelatedEntity();
      try { this.validateEntity(RelatedEntity); } catch { continue; }

      const parentPk = this.getParentPkValue(instance, entityClass);
      if (parentPk === undefined || parentPk === null) continue;

      let tableName: string;
      let joinColumn: string;
      let inverseJoinColumn: string;

      if (rel.joinTable) {
        // Owning side
        tableName = rel.joinTable.name;
        joinColumn = rel.joinTable.joinColumn;
        inverseJoinColumn = rel.joinTable.inverseJoinColumn;
      } else if (rel.mappedBy) {
        // Inverse side — look up owning side's joinTable
        const owningMeta: ManyToManyMetadata<any>[] =
          Reflect.getMetadata(MANY_TO_MANY_TOKEN, RelatedEntity) ?? [];
        const owningRel = owningMeta.find(
          (r) => r.propertyKey === rel.mappedBy,
        );
        if (!owningRel?.joinTable) continue;
        // Swap columns for inverse side
        tableName = owningRel.joinTable.name;
        joinColumn = owningRel.joinTable.inverseJoinColumn;
        inverseJoinColumn = owningRel.joinTable.joinColumn;
      } else {
        continue;
      }

      this.injectLazyM2MProxy(
        instance, rel.propertyKey, RelatedEntity,
        tableName, joinColumn, inverseJoinColumn, parentPk,
      );
    }
  }

  /**
   * Inject a lazy collection proxy (for O2M).
   * First access returns a Promise<T[]>; after resolution, the property
   * holds the actual array.
   */
  private injectLazyCollectionProxy(
    instance: any,
    propertyKey: string,
    ChildEntity: ClazzType<any>,
    where: Record<string, any>,
  ): void {
    let loaded = false;
    let cachedValue: any[] | undefined;

    Object.defineProperty(instance, propertyKey, {
      configurable: true,
      enumerable: true,
      get: () => {
        if (loaded) return cachedValue;
        const promise = this.ctx.em.find(ChildEntity, { where: where as any })
          .then((results) => {
            cachedValue = results.map((r) => this.resolveIdentity(ChildEntity, r));
            loaded = true;
            Object.defineProperty(instance, propertyKey, {
              configurable: true, enumerable: true, writable: true,
              value: cachedValue,
            });
            return cachedValue;
          });
        return promise;
      },
      set: (value: any) => {
        loaded = true;
        cachedValue = value;
        Object.defineProperty(instance, propertyKey, {
          configurable: true, enumerable: true, writable: true, value,
        });
      },
    });
  }

  /**
   * Inject a lazy M2M proxy that queries the pivot table + loads entities.
   */
  private injectLazyM2MProxy(
    instance: any,
    propertyKey: string,
    RelatedEntity: ClazzType<any>,
    tableName: string,
    joinColumn: string,
    inverseJoinColumn: string,
    parentPk: any,
  ): void {
    let loaded = false;
    let cachedValue: any[] | undefined;

    Object.defineProperty(instance, propertyKey, {
      configurable: true,
      enumerable: true,
      get: () => {
        if (loaded) return cachedValue;

        const relatedPkCols = this.getColumnInfo(RelatedEntity).pkColumns;
        if (relatedPkCols.length !== 1) {
          loaded = true;
          cachedValue = [];
          return [];
        }

        const wrappedTable = this.ctx.wrapTable(tableName);
        const wrappedJoinCol = this.ctx.wrap(joinColumn);
        const wrappedInverseCol = this.ctx.wrap(inverseJoinColumn);
        const relatedPk = relatedPkCols[0];

        const promise = this.ctx.em.query(
          `SELECT ${wrappedInverseCol} FROM ${wrappedTable} WHERE ${wrappedJoinCol} = ?`,
          [parentPk],
        ).then(async (rows: any[]) => {
          const ids = rows.map((r: any) => r[inverseJoinColumn]);
          if (ids.length === 0) {
            cachedValue = [];
            loaded = true;
            Object.defineProperty(instance, propertyKey, {
              configurable: true, enumerable: true, writable: true, value: [],
            });
            return [];
          }
          const results: any[] = [];
          for (const id of ids) {
            const result = await this.ctx.em.findOne(RelatedEntity, {
              where: { [relatedPk]: id } as any,
            });
            if (result) results.push(this.resolveIdentity(RelatedEntity, result));
          }
          cachedValue = results;
          loaded = true;
          Object.defineProperty(instance, propertyKey, {
            configurable: true, enumerable: true, writable: true, value: results,
          });
          return results;
        });
        return promise;
      },
      set: (value: any) => {
        loaded = true;
        cachedValue = value;
        Object.defineProperty(instance, propertyKey, {
          configurable: true, enumerable: true, writable: true, value,
        });
      },
    });
  }
}
