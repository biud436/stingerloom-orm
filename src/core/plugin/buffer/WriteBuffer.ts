/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { Logger } from "../../../utils/Logger";
import { FindOption } from "../../../dialects/FindOption";
import { PluginContext } from "../PluginContext";
import { TrackedEntry, InsertEntry, DeleteEntry, PersistEntry } from "./BufferEntry";
import {
  BufferPreviewEntry, BufferFlushResult, BufferPluginOptions, BufferChangeset,
  ChangeTrackingPolicy, FlushMode,
  FlushEventType, FlushEventListener,
  BulkUpdateEntry, BulkDeleteEntry,
  ResolvedBufferOptions,
  resolveCascadeOptions,
  buildSavePreviewEntry,
} from "./BufferPreview";
import { BufferStrategy, SnapshotStrategy, deepEquals } from "./BufferStrategy";
import { EntityState } from "./EntityUnitState";
import { sortForInsert, sortForDelete, buildTopologicalIndexMap, sortByIndex } from "./DependencyGraph";
import {
  snapshotCollections, diffCollection, readLoadedRelationValue,
  resolveFkWriteKeys, assignFkValue,
} from "./CollectionTracker";
import { hasCascade } from "../../../types/CascadeType";
import type { CollectionSnapshot, CollectionDiff } from "./CollectionTracker";
import { MANY_TO_ONE_TOKEN } from "../../../decorators/ManyToOne";
import { ONE_TO_MANY_TOKEN } from "../../../decorators/OneToMany";
import { ONE_TO_ONE_TOKEN } from "../../../decorators/OneToOne";
import { MANY_TO_MANY_TOKEN } from "../../../decorators/ManyToMany";
import { createPersistentCollection } from "./PersistentCollection";
import { IdentityMapManager } from "./IdentityMapManager";
import { CascadeProcessor } from "./CascadeProcessor";
import type { ReparentedChildren } from "./CascadeProcessor";
import { FlushExecutor } from "./FlushExecutor";
import { EntityValidator } from "../../EntityValidator";
import { LazyRelationInjector } from "./LazyRelationInjector";
import { transactionStorage } from "../../../decorators/Transactional";
import type { EntityManager } from "../../EntityManager";

/**
 * Sentinel snapshot value used by merge() to force a detached instance's
 * defined columns to diff as changed. It is a unique Symbol, so `deepEquals`
 * never reports it equal to a real column value — guaranteeing an UPDATE of
 * exactly the columns the detached instance carries.
 */
const MERGE_DIRTY_SENTINEL = Symbol("stingerloom.buffer.mergeDirty");

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
  private static readonly logger = new Logger("WriteBuffer");
  private readonly trackedEntries = new Map<any, TrackedEntry>();
  // PK-only stubs created by getReference(): registered in the identity map but
  // NOT yet hydrated. findOne() must treat a stub as a cache miss and load it
  // from the DB (then hydrate it in place) instead of returning the stub.
  private readonly referenceStubs = new WeakSet<object>();
  private readonly insertQueue: InsertEntry[] = [];
  private readonly deleteQueue: DeleteEntry[] = [];
  private readonly persistQueue: PersistEntry[] = [];
  private readonly bulkUpdateQueue: BulkUpdateEntry[] = [];
  private readonly bulkDeleteQueue: BulkDeleteEntry[] = [];
  private readonly strategy: BufferStrategy;
  private readonly ctx: PluginContext;
  private readonly options: ResolvedBufferOptions;
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
    const resolvedCascade = resolveCascadeOptions(options.cascade);
    this.options = {
      retainAfterFlush: options.retainAfterFlush ?? true,
      cascade: resolvedCascade,
      orphanRemoval: options.orphanRemoval ?? false,
      manyToManySync: options.manyToManySync ?? resolvedCascade.persist,
      autoFlush: options.autoFlush ?? false,
      flushMode: options.flushMode ?? (options.autoFlush ? FlushMode.AUTO : FlushMode.MANUAL),
      onFlush: options.onFlush ?? (() => {}),
      batchInsert: options.batchInsert ?? false,
      batchUpdate: options.batchUpdate ?? false,
      changeTracking: options.changeTracking ?? ChangeTrackingPolicy.DEFERRED_IMPLICIT,
      logging: options.logging ?? false,
      maxIdentityMapSize: options.maxIdentityMapSize,
      validateBeforeFlush: options.validateBeforeFlush ?? false,
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
    this.idMap.setMaxSize(options.maxIdentityMapSize);
    this.idMap.setTrackedEntries(this.trackedEntries, this.strategy);
    this.cascade = new CascadeProcessor(ctx, this.idMap, this.options);
    this.flushExec = new FlushExecutor(
      ctx, this.idMap, this.cascade, this.options, this.strategy, this.flushListeners,
    );
    this.lazyInjector = new LazyRelationInjector(
      ctx, this.idMap, this.resolveIdentity.bind(this),
      this.captureLoadedCollectionSnapshot.bind(this),
    );
  }

  /**
   * Capture a collection's baseline snapshot the moment its lazy proxy
   * materializes.
   *
   * track() snapshots collections eagerly, but it runs BEFORE lazy proxies are
   * injected — so an unloaded (proxy) O2M/M2M collection has no snapshot
   * baseline. Without one, the flush collection-diff step skips the property
   * entirely and a later add/remove on the loaded collection is silently
   * dropped. Recording the baseline here (from the freshly loaded items) lets
   * the diff detect those mutations.
   */
  private captureLoadedCollectionSnapshot(instance: any, propertyKey: string): void {
    const entry = this.trackedEntries.get(instance);
    if (!entry) return;
    // The property now holds the loaded array, so snapshotCollections captures
    // exactly the loaded items as the originalItems baseline.
    const snaps = snapshotCollections(instance, entry.entity);
    const match = snaps.find((s) => s.propertyKey === propertyKey);
    if (!match) return;
    const existing = entry.collectionSnapshots ?? [];
    // Only fill the gap left by a lazy load — never clobber a baseline already
    // captured for this property (e.g. an eagerly-loaded collection).
    if (existing.some((s) => s.propertyKey === propertyKey)) return;
    existing.push(match);
    entry.collectionSnapshots = existing;
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
    this.idMap.evictIfNeeded();

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
        // A reference stub (getReference) is PK-only and not hydrated, so it is
        // NOT a valid cache hit — fall through to the DB load, which hydrates it.
        // The instanceof guard covers STI/TPT root-keyed entries: a sibling-type
        // PK lookup must go to the DB (whose discriminator filter answers it),
        // never serve the cached instance of another subtype.
        if (cached && !this.referenceStubs.has(cached) && cached instanceof entity) {
          this.idMap.touch(cacheKey);
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
    // Non-canonical reads (partial select / soft-deleted / unscoped) must not
    // create a NEW identity-map entry — a partial or trashed row would poison
    // later canonical PK lookups. Return the already-tracked canonical instance
    // if one exists, otherwise the raw row untracked.
    if (!this.isCanonicalReadOption(option)) {
      return this.mapThroughExisting(entity, result) as T;
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
    // Non-canonical reads (partial select / soft-deleted / unscoped) map
    // through the identity map without creating new entries — see findOne().
    const canonical = this.isCanonicalReadOption(option);
    return results.map((item) =>
      canonical
        ? (this.resolveIdentity(entity, item) as T)
        : (this.mapThroughExisting(entity, item) as T),
    );
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
   * The stub is snapshot-tracked with a PK-only baseline, so columns written
   * on it are detected as dirty and flushed as a targeted UPDATE. Relation
   * properties are initialized as lazy proxies — accessing them triggers a DB
   * query and registers the loaded entities in this buffer; FK-dependent
   * relations (@ManyToOne / owning @OneToOne) hydrate the stub's own row
   * first, then load the target.
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
    if (existing) {
      // Root-keyed inheritance entries may hold a different subtype than the
      // requested class — surface that instead of returning a type lie.
      // Either direction of the hierarchy is fine (a root-class stub can
      // serve a subclass reference and vice versa).
      if (
        !(existing instanceof entityClass) &&
        !((entityClass as any).prototype instanceof (existing as any).constructor)
      ) {
        throw new Error(
          `Identity conflict: the row (${key}) is already tracked as ` +
          `"${(existing as any).constructor?.name}", not "${entityClass.name}".`,
        );
      }
      this.idMap.touch(key);
      return existing as T;
    }

    // Snapshot-track the stub with a PK-only baseline: exactly the columns
    // the caller writes on it diff as dirty, so stub writes flush as a
    // targeted UPDATE instead of being silently dropped. Mark it as a
    // reference stub so a later findOne() hydrates it from the DB rather
    // than returning the PK-only instance from the first-level cache.
    this.track(instance);
    this.referenceStubs.add(instance);

    // Inject lazy proxies for relation properties. The stub carries no FK
    // values, so FK-dependent relations hydrate the stub's own row on first
    // access (which also re-baselines the tracked snapshot).
    const hydrateStub = async (): Promise<void> => {
      if (!this.referenceStubs.has(instance)) return; // already hydrated
      const where = this.idMap.buildPkWhere(instance, pkColumns);
      const loaded = await this.ctx.em.findOne(entityClass, { where: where as any });
      if (loaded) this.resolveIdentity(entityClass, loaded);
    };
    this.lazyInjector.injectLazyRelations(instance, entityClass, hydrateStub);

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

    if (hasPk) {
      // A DB-generated PK (auto-increment / uuid) is only present once the row
      // exists, so a present value means the entity was loaded → track it as
      // managed. An APPLICATION-ASSIGNED PK (@PrimaryColumn / natural key) is
      // always set on a brand-new entity, so its presence tells us nothing about
      // whether the row exists: only treat it as managed if the buffer already
      // knows the instance (tracked, or MANAGED from a prior flush). Otherwise
      // it is a new entity that must be INSERTed — falling through to the queue.
      const alreadyKnown =
        this.trackedEntries.has(instance) ||
        this.idMap.stateMap.get(instance) === EntityState.MANAGED;
      if (this.idMap.hasGeneratedPk(entityClass) || alreadyKnown) {
        this.cancelQueuedDelete(entityClass, instance, pkColumns);
        return this.track(instance);
      }
    }

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

    // If in persistQueue → cancel INSERT, no DELETE needed.
    // Checked before PK validation so a NEW entity whose PK has not been
    // generated yet can still be removed (the pending INSERT is cancelled).
    const idx = this.persistQueue.findIndex(e => e.instance === instance);
    if (idx !== -1) {
      this.persistQueue.splice(idx, 1);
      if (this.trackedEntries.has(instance)) this.untrack(instance);
      this.idMap.stateMap.delete(instance);
      return this;
    }

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

    this.deleteQueue.push({ entity: entityClass, criteria });
    this.idMap.stateMap.set(instance, EntityState.REMOVED);
    if (this.options.logging) this.log("remove (queued DELETE)", { entity: entityClass.name, criteria });
    return this;
  }

  /**
   * Cancel pending DELETEs queued for the same entity + PK.
   * persist() after remove() re-manages the entity instead of deleting it
   * (Hibernate semantics: persisting a removed entity cancels the removal).
   * Only exact PK-shaped criteria are cancelled — criteria deletes queued
   * via delete() with non-PK shapes are left untouched.
   */
  private cancelQueuedDelete(
    entityClass: ClazzType<any>,
    instance: any,
    pkColumns: string[],
  ): void {
    for (let i = this.deleteQueue.length - 1; i >= 0; i--) {
      const e = this.deleteQueue[i];
      if (
        e.entity === entityClass &&
        Object.keys(e.criteria).length === pkColumns.length &&
        pkColumns.every(pk => e.criteria[pk] === instance[pk])
      ) {
        this.deleteQueue.splice(i, 1);
      }
    }
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

    this.idMap.stateMap.delete(instance);

    // Cascade detach
    if (this.options.cascade.detach) {
      const entityClass = instance.constructor as ClazzType<any>;
      this.cascade.propagateToRelations(instance, entityClass, (child) => {
        this.detach(child, seen);
      });
    }

    return this;
  }

  /**
   * Detach a tracked entity by class + primary key, without needing the
   * instance reference. Useful when only a PK is available (e.g. from an
   * external API request).
   *
   * Looks up the instance in the Identity Map and delegates to `detach()`.
   * If no matching instance is tracked, this is a no-op (idempotent).
   *
   * Cascade behavior follows the same rules as `detach(instance)`.
   *
   * @param entityClass — the entity class
   * @param pk — scalar PK value, or an object for composite PKs
   */
  detachByPk<T>(entityClass: ClazzType<T>, pk: any): this {
    this.idMap.validateEntity(entityClass);
    const { pkColumns } = this.idMap.getColumnInfo(entityClass);

    // Build a probe instance to compute the identity key.
    // Mirrors the PK normalization in getReference().
    const probe = new (entityClass as any)();
    if (pkColumns.length === 1 && (typeof pk !== "object" || pk === null || pk instanceof Date)) {
      probe[pkColumns[0]] = pk;
    } else if (typeof pk === "object" && pk !== null) {
      for (const [k, v] of Object.entries(pk)) {
        probe[k] = v;
      }
    }

    let key: string;
    try {
      key = this.idMap.buildIdentityKey(entityClass as ClazzType<any>, probe, pkColumns);
    } catch {
      // PK columns missing → nothing to detach
      return this;
    }

    const existing = this.idMap.identityMap.get(key);
    if (existing) {
      return this.detach(existing);
    }

    if (this.options.logging) this.log("detachByPk → no-op (not tracked)", { entity: entityClass.name, key });
    return this;
  }

  /**
   * Detach every tracked entity and pending persist-queue instance,
   * transitioning each to `EntityState.DETACHED` and clearing the
   * Identity Map.
   *
   * Pending persist-queue entries are removed (their queued INSERTs
   * are cancelled). Other queues — `delete`, `bulkUpdate`, `bulkDelete`
   * and legacy `save`/`delete` queues — are left intact, since they
   * operate on classes/criteria rather than tracked instances. Use
   * `clear()` for a full reset.
   */
  detachAll(): this {
    const detachedInstances: any[] = [];

    // Snapshot persist-queue instances, then clear the queue
    for (const entry of this.persistQueue) {
      detachedInstances.push(entry.instance);
    }
    this.persistQueue.length = 0;

    // Snapshot tracked instances, then clear tracking + identity map
    for (const instance of this.trackedEntries.keys()) {
      detachedInstances.push(instance);
    }
    this.trackedEntries.clear();
    this.idMap.identityMap.clear();

    // Transition each to DETACHED
    for (const instance of detachedInstances) {
      this.idMap.stateMap.delete(instance);
    }

    if (this.options.logging) {
      this.log("detachAll", { count: detachedInstances.length });
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

    let mergedIntoExisting = false;
    try {
      const key = this.idMap.buildIdentityKey(entityClass, instance, pkColumns);
      const existing = this.idMap.identityMap.get(key);
      if (existing && existing !== instance) {
        for (const col of columnNames) {
          if (instance[col] !== undefined) existing[col] = instance[col];
        }
        mergedIntoExisting = true;
      }
    } catch (err) {
      // PK missing → track as new; only swallow identity key errors
      if (!(err instanceof Error && /PK column/.test(err.message))) throw err;
    }

    if (!mergedIntoExisting) {
      // Not in the identity map. A full PK means this is a DETACHED entity
      // representing an existing row, so its columns must be written back on
      // flush — plain track() snapshots the current values and yields a zero
      // diff, silently dropping the detached edits. Track it with a
      // forced-dirty baseline so exactly the columns it carries are UPDATEd.
      const hasFullPk =
        pkColumns.length > 0 &&
        pkColumns.every((pk) => instance[pk] !== undefined && instance[pk] !== null);
      if (hasFullPk && !this.trackedEntries.has(instance)) {
        this.trackAsMergedDetached(instance, entityClass, columnNames, pkColumns);
      } else {
        this.track(instance);
      }
    }

    // Cascade merge
    if (this.options.cascade.merge) {
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
   * Track a detached instance for merge() so that every column it actually
   * defines is written back on flush.
   *
   * A normal track() snapshots the instance's current values, so the flush
   * dirty-check finds no difference and the detached edits are lost. Here the
   * snapshot is seeded with {@link MERGE_DIRTY_SENTINEL} for each defined
   * non-PK column, which never equals a real value — forcing those columns
   * dirty. Columns the caller left undefined keep an undefined baseline and are
   * not touched, so unset columns are never accidentally nulled out.
   */
  private trackAsMergedDetached(
    instance: any,
    entityClass: ClazzType<any>,
    columnNames: string[],
    pkColumns: string[],
  ): void {
    this.track(instance);
    const entry = this.trackedEntries.get(instance);
    if (!entry) return;
    const forced: Record<string, any> = {};
    for (const col of columnNames) {
      if (pkColumns.includes(col)) {
        forced[col] = instance[col];
      } else {
        forced[col] = instance[col] === undefined ? undefined : MERGE_DIRTY_SENTINEL;
      }
    }
    entry.snapshot = forced;
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
    if (this.options.cascade.refresh) {
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
    this.idMap.stateMap.delete(instance);
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
    bulkUpdates: number; bulkDeletes: number; identityMap: number;
  } {
    return {
      tracked: this.trackedEntries.size,
      inserts: this.insertQueue.length,
      deletes: this.deleteQueue.length,
      persists: this.persistQueue.length,
      bulkUpdates: this.bulkUpdateQueue.length,
      bulkDeletes: this.bulkDeleteQueue.length,
      identityMap: this.idMap.identityMap.size,
    };
  }

  /**
   * Preview the operations flush() will execute, in execution order:
   * updates → persists (with cascade-persist children) → legacy inserts →
   * collection diffs (O2M cascade writes, orphan removals, M2M pivot sync) →
   * deletes → bulk updates → bulk deletes.
   *
   * Mirrors flush()'s eligibility rules: read-only entries and — under
   * `ChangeTrackingPolicy.DEFERRED_EXPLICIT` — entries not marked dirty are
   * excluded from updates AND collection-diff processing, exactly as flush
   * excludes them. Orphan-removal entries spare reparented children with the
   * same identity/PK matching flush applies.
   *
   * Known gaps versus the actual flush (DB state is not consulted; see the
   * write-buffer guide):
   * - Cascade DELETE expansion (children of a queued delete discovered via
   *   DB queries) is not listed — only the queued delete itself appears.
   * - DB-generated PKs do not exist yet, so FK / pivot values derived from
   *   them are omitted from entry data (the operations are still listed),
   *   and the owning-side O2O FK fix-up UPDATE is not listed.
   * - Cascade re-saves of children of dirty TRACKED parents are not listed.
   */
  preview(): BufferPreviewEntry[] {
    const entries: BufferPreviewEntry[] = [];
    const visited = new Set<any>();
    const indexMap = buildTopologicalIndexMap(this.ctx.getEntities());

    // 1. Updates — same eligibility filter + topological order as flush
    const eligible = sortByIndex(
      [...this.trackedEntries.values()].filter(
        (e) => !e.readOnly && this.shouldDirtyCheck(e),
      ),
      indexMap,
    );
    for (const entry of eligible) {
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
        visited.add(entry.instance);
      }
    }

    // 2. Persists (instance-based inserts) + their cascade-persist children
    const sortedPersists = sortByIndex([...this.persistQueue], indexMap);
    for (const entry of sortedPersists) {
      const data: Record<string, any> = {};
      for (const col of entry.columnNames) {
        if (entry.instance[col] !== undefined) data[col] = entry.instance[col];
      }
      entries.push({
        action: "insert",
        entity: entry.entity.name,
        data,
      });
      visited.add(entry.instance);
      this.cascade.collectCascadePreviewInserts(entry.entity, entry.instance, visited, entries);
    }

    // 3. Legacy inserts (plain object)
    for (const insert of this.insertQueue) {
      entries.push({
        action: "insert",
        entity: insert.entity.name,
        data: insert.data,
      });
    }

    // 4. Collection diffs — same two-pass reparent handling as flush
    const { reparented, pendingDiffs } = this.collectCollectionDiffs(eligible);
    for (const { entry, colSnap, diff } of pendingDiffs) {
      if (colSnap.relationType === "oneToMany") {
        const childInfo = this.idMap.getColumnInfo(colSnap.relatedEntity);
        const parentPk = this.idMap.getParentPkValue(entry.instance, entry.entity);

        if (this.options.cascade.persist && hasCascade(colSnap.cascade, "insert")) {
          const fkKeys = colSnap.mappedBy
            ? resolveFkWriteKeys(colSnap.mappedBy, colSnap.relatedEntity)
            : undefined;
          for (const child of diff.added) {
            if (visited.has(child)) continue;
            visited.add(child);
            const childData: Record<string, any> = {};
            for (const col of childInfo.columnNames) {
              if (child[col] !== undefined) childData[col] = child[col];
            }
            if (fkKeys && parentPk != null) assignFkValue(childData, fkKeys, parentPk);
            entries.push(
              buildSavePreviewEntry(colSnap.relatedEntity.name, childData, childInfo.pkColumns),
            );
          }
        }

        if (this.options.orphanRemoval) {
          const reparentedPks = reparented.pks.get(colSnap.relatedEntity.name);
          for (const child of diff.removed) {
            if (reparented.instances.has(child)) continue;
            const criteria: Record<string, any> = {};
            for (const pk of childInfo.pkColumns) {
              const v = child[pk];
              if (v !== undefined && v !== null) criteria[pk] = v;
            }
            if (Object.keys(criteria).length === 0) continue;
            if (
              reparentedPks &&
              childInfo.pkColumns.length === 1 &&
              reparentedPks.has(criteria[childInfo.pkColumns[0]])
            ) {
              continue;
            }
            entries.push({
              action: "delete",
              entity: colSnap.relatedEntity.name,
              criteria,
            });
          }
        }
      } else if (colSnap.relationType === "manyToMany") {
        if (!this.options.manyToManySync || !colSnap.joinTable) continue;
        const { name: pivotName, joinColumn, inverseJoinColumn } = colSnap.joinTable;
        const parentPk = this.idMap.getParentPkValue(entry.instance, entry.entity);
        const childPkColumns = this.idMap.getColumnInfo(colSnap.relatedEntity).pkColumns;
        for (const child of diff.added) {
          const childPk = childPkColumns.length === 1 ? child[childPkColumns[0]] : null;
          if (childPk == null) continue;
          entries.push({
            action: "insert",
            entity: pivotName,
            data: { [joinColumn]: parentPk, [inverseJoinColumn]: childPk },
          });
        }
        for (const child of diff.removed) {
          const childPk = childPkColumns.length === 1 ? child[childPkColumns[0]] : null;
          if (childPk == null) continue;
          entries.push({
            action: "delete",
            entity: pivotName,
            criteria: { [joinColumn]: parentPk, [inverseJoinColumn]: childPk },
          });
        }
      }
    }

    // 5. Deletes (reverse topological order, matching flush)
    const sortedDeletes = sortByIndex([...this.deleteQueue], indexMap, true);
    for (const del of sortedDeletes) {
      entries.push({
        action: "delete",
        entity: del.entity.name,
        criteria: del.criteria,
      });
    }

    // 6. Bulk updates
    for (const bu of this.bulkUpdateQueue) {
      entries.push({
        action: "bulkUpdate",
        entity: bu.entity.name,
        where: bu.where,
        set: bu.set,
      });
    }

    // 7. Bulk deletes
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
   * First pass of collection-diff processing, shared by flush() and
   * preview(): compute every collection diff for the given (already
   * eligibility-filtered) tracked entries, and collect the children ADDED to
   * any parent's O2M collection — by identity and by PK — so orphan removal
   * can spare reparented children (a child moved from parent A to B lands in
   * A.removed AND B.added).
   */
  private collectCollectionDiffs(trackedList: TrackedEntry[]): {
    reparented: ReparentedChildren;
    pendingDiffs: Array<{ entry: TrackedEntry; colSnap: CollectionSnapshot; diff: CollectionDiff }>;
  } {
    const reparented: ReparentedChildren = { instances: new Set(), pks: new Map() };
    const pendingDiffs: Array<{ entry: TrackedEntry; colSnap: CollectionSnapshot; diff: CollectionDiff }> = [];
    for (const entry of trackedList) {
      if (!entry.collectionSnapshots) continue;
      for (const colSnap of entry.collectionSnapshots) {
        const diff = diffCollection(entry.instance, colSnap);
        if (!diff) continue;
        pendingDiffs.push({ entry, colSnap, diff });
        if (colSnap.relationType === "oneToMany") {
          const childPks = this.idMap.getColumnInfo(colSnap.relatedEntity).pkColumns;
          for (const child of diff.added) {
            reparented.instances.add(child);
            if (childPks.length === 1) {
              const pk = child[childPks[0]];
              if (pk != null) {
                const name = colSnap.relatedEntity.name;
                let set = reparented.pks.get(name);
                if (!set) { set = new Set(); reparented.pks.set(name, set); }
                set.add(pk);
              }
            }
          }
        }
      }
    }
    return { reparented, pendingDiffs };
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

    // Pre-flush validation: check @Validation constraints before touching the DB
    if (this.options.validateBeforeFlush) {
      this.validateAll();
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

    // Snapshot the pre-flush column values of every instance flush may mutate,
    // so a mid-flush failure (the whole transaction rolls back) can restore
    // them. Otherwise a persisted instance keeps a PK / an incremented @Version
    // / a timestamp for a row that no longer exists — ghost state that also
    // triggers a spurious OptimisticLockError on retry.
    const preFlushState = this.capturePreFlushColumnState(persistsCopy);

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
              // @Version: ensure version is incremented on the instance
              // (MySQL without RETURNING may not return the new value)
              this.flushExec.ensureVersionIncrement(entry.entity, entry.instance, entry.snapshot);
              // @UpdateTimestamp: ensure timestamp is set on the instance
              this.flushExec.ensureTimestamps(entry.entity, entry.instance, false);
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
            // @CreateTimestamp / @UpdateTimestamp: ensure timestamps on the instance
            this.flushExec.ensureTimestamps(entry.entity, entry.instance, true);
            result.inserts++;
            visited.add(entry.instance);
            await this.flushExec.emitFlushEvent("postInsert", entry.entity, entry.instance);
            await this.cascade.processCascadeInsertUpdate(txEm, entry.entity, entry.instance, visited, result, true);
          }
        }

        // 3. Legacy inserts (plain object)
        for (const insert of insertsCopy) {
          await txEm.save(insert.entity, insert.data);
          result.inserts++;
        }

        // 4. Collection diffs (O2M orphan removal + M2M pivot sync)
        // First pass (shared with preview()): compute every diff and collect
        // the children ADDED to any parent's O2M collection, so orphan
        // removal below spares reparented children.
        const { reparented, pendingDiffs } = this.collectCollectionDiffs(sortedTracked);
        for (const { entry, colSnap, diff } of pendingDiffs) {
          if (colSnap.relationType === "oneToMany") {
            await this.cascade.processOneToManyCollectionDiff(txEm, entry, diff, visited, result, reparented);
          } else if (colSnap.relationType === "manyToMany") {
            await this.cascade.processManyToManyCollectionDiff(txEm, entry, diff, result);
          }
        }

        // 5. Cascade delete — before parent delete, cascade-delete children
        if (this.options.cascade.remove) {
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
          // Keep the first-level cache honest: a criteria delete (or cascade
          // delete) must not leave a matching tracked instance behind, or a
          // later PK findOne would return the just-deleted row from cache.
          this.flushExec.evictTrackedMatching(del.entity, del.criteria, this.trackedEntries);
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

      // Both nested and top-level flush run inside em.transaction(). With an
      // ambient transaction (the caller wrapped the workflow in
      // em.transaction()), REQUIRED propagation joins it — so a nested
      // buffer's SAVEPOINT really is a savepoint inside the caller's
      // transaction, and a later rollback of that transaction undoes this
      // flush too. WITHOUT an ambient transaction, this flush opens and
      // commits its own transaction: the SAVEPOINT spans nothing beyond it,
      // and no parent rollback can ever reclaim the committed work.
      if (this.parent && !transactionStorage.getStore()) {
        WriteBuffer.logger.warn(
          "Nested buffer flush() called outside an enclosing transaction: " +
          "this flush commits immediately and independently, so its SAVEPOINT " +
          "gives no partial-rollback protection and a later parent rollback " +
          "will NOT undo this work. Wrap the whole workflow in " +
          "em.transaction(async () => { ... }) for real savepoint semantics.",
        );
      }
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
      // Undo the in-place mutations flush applied to instances before it failed
      // (PK write-back, @Version bump, timestamps). The DB rolled the whole
      // transaction back, so restoring the pre-flush column values leaves each
      // instance exactly as the user left it — ready for a clean retry.
      this.restorePreFlushColumnState(preFlushState);
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

  /**
   * Snapshot the current column values of every instance a flush may mutate:
   * all persist-queue instances (PK write-back), all tracked instances
   * (write-back / @Version bump / timestamps on UPDATE), and every instance
   * reachable from those roots through LOADED relation values — cascade
   * inserts mutate children in place too (generated PK, FK columns,
   * timestamps). Unloaded lazy proxies are never triggered by the walk.
   *
   * Returns a map from instance → its pre-flush column values, used by
   * {@link restorePreFlushColumnState} to undo those mutations if the flush
   * transaction rolls back.
   */
  private capturePreFlushColumnState(
    persists: PersistEntry[],
  ): Map<any, Record<string, any>> {
    const state = new Map<any, Record<string, any>>();
    const record = (instance: any): void => {
      if (instance === null || typeof instance !== "object" || state.has(instance)) return;
      const ctor = instance.constructor as ClazzType<any>;
      if (typeof ctor !== "function" || (ctor as unknown) === Object) return;
      const { columnNames } = this.idMap.getColumnInfo(ctor);
      if (columnNames.length === 0) return;
      const snap: Record<string, any> = {};
      for (const col of columnNames) snap[col] = instance[col];
      state.set(instance, snap);
      // Recurse into cascade-reachable children (loaded relations only).
      this.cascade.forEachLoadedRelated(instance, ctor, record);
    };
    for (const entry of persists) record(entry.instance);
    for (const entry of this.trackedEntries.values()) {
      record(entry.instance);
    }
    return state;
  }

  /**
   * Restore instances to the column values captured by
   * {@link capturePreFlushColumnState}, undoing flush's in-place mutations
   * after a rolled-back transaction.
   */
  private restorePreFlushColumnState(
    state: Map<any, Record<string, any>>,
  ): void {
    for (const [instance, snap] of state) {
      for (const col of Object.keys(snap)) {
        instance[col] = snap[col];
      }
    }
  }

  /**
   * Validate all dirty tracked entities and persist queue entries
   * using @Validation decorator metadata. Throws ValidationError
   * on the first failure, aborting flush before any DB write.
   */
  private validateAll(): void {
    // Dirty tracked entities (updates)
    for (const entry of this.trackedEntries.values()) {
      if (entry.readOnly) continue;
      if (!this.shouldDirtyCheck(entry)) continue;
      const diff = this.strategy.diff(
        entry.instance,
        entry.snapshot,
        entry.columnNames,
        entry.pkColumns,
      );
      if (diff) {
        EntityValidator.validate(entry.entity, entry.instance);
      }
    }
    // Persist queue (inserts)
    for (const entry of this.persistQueue) {
      EntityValidator.validate(entry.entity, entry.instance);
    }
  }

  /**
   * A read is "canonical" when its result faithfully represents the full,
   * live row: all columns loaded, soft-deleted rows excluded, and the active
   * tenant scope applied. Only canonical reads may populate the identity map;
   * partial (`select`), soft-delete-inclusive (`withDeleted` / `onlyDeleted`),
   * and unscoped (`withoutTenantScope`) reads must not, or they would poison
   * later PK lookups with a downgraded instance.
   */
  private isCanonicalReadOption(option: FindOption<any>): boolean {
    return !(
      option.select ||
      option.withDeleted ||
      option.onlyDeleted ||
      option.withoutTenantScope
    );
  }

  /**
   * Return the already-tracked canonical instance for a freshly loaded row if
   * one exists (preserving object identity), otherwise the row as-is — without
   * ever inserting a new identity-map entry. Used for non-canonical reads.
   */
  private mapThroughExisting(entityClass: ClazzType<any>, instance: any): any {
    try {
      const { pkColumns } = this.idMap.getColumnInfo(entityClass);
      const key = this.idMap.buildIdentityKey(entityClass, instance, pkColumns);
      const existing = this.idMap.identityMap.get(key);
      if (existing && !this.referenceStubs.has(existing)) {
        this.idMap.touch(key);
        return existing;
      }
    } catch {
      // PK column missing (e.g. a `select` that omits the PK) → nothing to map.
    }
    return instance;
  }

  private resolveIdentity(entityClass: ClazzType<any>, instance: any): any {
    return this.resolveIdentityGraph(entityClass, instance, new Map());
  }

  /**
   * Identity-resolve a freshly loaded instance AND its eagerly loaded
   * relation graph.
   *
   * Every loaded M2O / O2O / O2M / M2M child is resolved through the identity
   * map — registered, snapshot-tracked, and given lazy proxies for its own
   * unloaded relations — so a later edit on an eager-loaded child is detected
   * as dirty. On an identity-map hit, the freshly fetched relation values are
   * attached to the canonical instance when it does not have them loaded yet
   * (a hit must not discard relations the caller explicitly fetched).
   *
   * The `resolved` map carries fresh → canonical mappings across the walk so
   * cyclic graphs (child back-references) terminate and duplicate fresh
   * instances of one row collapse to a single canonical instance.
   */
  private resolveIdentityGraph(
    entityClass: ClazzType<any>,
    instance: any,
    resolved: Map<any, any>,
  ): any {
    const prior = resolved.get(instance);
    if (prior !== undefined) return prior;

    let key: string;
    try {
      const { pkColumns } = this.idMap.getColumnInfo(entityClass);
      key = this.idMap.buildIdentityKey(entityClass, instance, pkColumns);
    } catch {
      // No usable PK (e.g. a partially selected child) — leave it untouched.
      resolved.set(instance, instance);
      return instance;
    }

    const existing = this.idMap.identityMap.get(key);
    if (existing) {
      resolved.set(instance, existing);
      this.idMap.touch(key);
      // If the mapped instance is an unhydrated getReference() stub, populate
      // it in place from the freshly loaded row and promote it to a fully
      // tracked entity — preserving identity for any FK references already
      // pointing at the stub.
      if (existing !== instance && this.referenceStubs.has(existing)) {
        this.hydrateReference(entityClass, existing, instance);
      }
      this.resolveLoadedRelations(entityClass, instance, existing, resolved);
      return existing;
    }

    // Pre-claim the identity slot BEFORE walking children, so a back-reference
    // to this same row deeper in the graph resolves to THIS instance instead
    // of tracking a duplicate (identity conflict).
    resolved.set(instance, instance);
    this.idMap.identityMap.set(key, instance);
    this.idMap.stateMap.set(instance, EntityState.MANAGED);
    this.resolveLoadedRelations(entityClass, instance, instance, resolved);
    // Track AFTER the children were swapped for canonical instances, so the
    // collection baseline snapshots exactly what the instance now holds.
    this.track(instance);
    this.lazyInjector.injectLazyRelations(instance, entityClass);
    return instance;
  }

  /**
   * Walk the LOADED relation values of a freshly loaded instance. Every child
   * is identity-resolved recursively; when the canonical root differs from
   * the fresh one (identity-map hit), freshly fetched relation values are
   * attached to the canonical instance if it lacks them. Unloaded lazy
   * proxies and in-flight loads are never triggered.
   */
  private resolveLoadedRelations(
    entityClass: ClazzType<any>,
    fresh: any,
    canonical: any,
    resolved: Map<any, any>,
  ): void {
    const ctor = fresh?.constructor;
    const cls = (typeof ctor === "function" && ctor !== Object
      ? ctor
      : entityClass) as ClazzType<any>;

    const m2oMeta: any[] = Reflect.getMetadata(MANY_TO_ONE_TOKEN, cls) ?? [];
    for (const rel of m2oMeta) {
      this.resolveSingleRelation(fresh, canonical, rel.columnName, rel.getMappingEntity?.(), resolved);
    }
    const o2oMeta: any[] = Reflect.getMetadata(ONE_TO_ONE_TOKEN, cls) ?? [];
    for (const rel of o2oMeta) {
      this.resolveSingleRelation(fresh, canonical, rel.propertyKey, rel.getRelatedEntity?.(), resolved);
    }
    const o2mMeta: any[] = Reflect.getMetadata(ONE_TO_MANY_TOKEN, cls) ?? [];
    for (const rel of o2mMeta) {
      this.resolveCollectionRelation(fresh, canonical, rel.propertyKey, rel.getRelatedEntity?.(), resolved);
    }
    const m2mMeta: any[] = Reflect.getMetadata(MANY_TO_MANY_TOKEN, cls) ?? [];
    for (const rel of m2mMeta) {
      this.resolveCollectionRelation(fresh, canonical, rel.propertyKey, rel.getRelatedEntity?.(), resolved);
    }
  }

  private resolveSingleRelation(
    fresh: any,
    canonical: any,
    prop: string,
    RelatedEntity: ClazzType<any> | undefined,
    resolved: Map<any, any>,
  ): void {
    if (!RelatedEntity) return;
    try { this.idMap.validateEntity(RelatedEntity); } catch { return; }
    const val = readLoadedRelationValue(fresh, prop);
    if (val === undefined || Array.isArray(val)) return;
    const child = this.resolveIdentityGraph(RelatedEntity, val, resolved);
    if (canonical === fresh) {
      if (child !== val) fresh[prop] = child;
    } else {
      this.attachFreshRelation(canonical, prop, child, false);
    }
  }

  private resolveCollectionRelation(
    fresh: any,
    canonical: any,
    prop: string,
    RelatedEntity: ClazzType<any> | undefined,
    resolved: Map<any, any>,
  ): void {
    if (!RelatedEntity) return;
    try { this.idMap.validateEntity(RelatedEntity); } catch { return; }
    const arr = readLoadedRelationValue(fresh, prop);
    if (!Array.isArray(arr)) return;
    const out = arr.map((item) =>
      item !== null && typeof item === "object"
        ? this.resolveIdentityGraph(RelatedEntity, item, resolved)
        : item,
    );
    if (canonical === fresh) {
      // Swap elements in place so the array identity the caller holds stays valid.
      for (let i = 0; i < out.length; i++) arr[i] = out[i];
    } else {
      this.attachFreshRelation(canonical, prop, out, true);
    }
  }

  /**
   * Attach a freshly loaded relation value to a canonical (identity-map hit)
   * instance — but ONLY when it does not already have that relation loaded. A
   * loaded value on the canonical instance may carry user edits and always
   * wins. Assigning through an unmaterialized lazy proxy's setter materializes
   * it; a just-materialized collection then gets its change-tracking baseline.
   */
  private attachFreshRelation(
    canonical: any,
    prop: string,
    value: any,
    isCollection: boolean,
  ): void {
    const desc = Object.getOwnPropertyDescriptor(canonical, prop);
    if (desc && "value" in desc && desc.value !== undefined) return;
    canonical[prop] = value;
    if (isCollection) this.captureLoadedCollectionSnapshot(canonical, prop);
  }

  /**
   * Copies the column values from a freshly loaded row into an existing
   * getReference() stub and clears its reference mark. Columns the caller
   * wrote on the stub BEFORE hydration (they differ from the PK-only tracked
   * baseline) are kept — they are pending user state — while the tracked
   * snapshot is re-baselined against the DB row, so exactly those writes stay
   * dirty and flush as an UPDATE. Relation properties keep their lazy proxies
   * (only column values are copied).
   */
  private hydrateReference(
    entityClass: ClazzType<any>,
    stub: any,
    loaded: any,
  ): void {
    const { columnNames } = this.idMap.getColumnInfo(entityClass);
    const entry = this.trackedEntries.get(stub);
    for (const col of columnNames) {
      const userWrote =
        entry !== undefined && !deepEquals(stub[col], entry.snapshot[col]);
      if (!userWrote) stub[col] = loaded[col];
    }
    this.referenceStubs.delete(stub);
    if (entry) {
      entry.snapshot = this.strategy.snapshot(loaded, entry.columnNames);
    } else {
      this.track(stub);
    }
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

  /** Structured log for buffer lifecycle events, routed through {@link Logger}. */
  private log(action: string, detail?: Record<string, any>): void {
    const extra = detail ? " " + JSON.stringify(detail) : "";
    WriteBuffer.logger.info(`${action}${extra}`);
  }
}
