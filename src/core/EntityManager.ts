/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { ClazzType, Logger, generateUUIDv7 } from "../utils";
import { ColumnMetadata, MetadataLayerRegistry } from "../scanner";
import { DatabaseClient } from "../DatabaseClient";
import { ISqlDriver } from "../dialects/SqlDriver";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { FindOption, LockMode, UpdateData, UpdateManyOptions, WhereClause } from "../dialects/FindOption";
import { resolveWhereClause } from "./WhereResolver";
import { ISelectOption } from "../dialects/ISelectOption";
import { IDataSource } from "../dialects/IDataSource";
import { Sql, isSqlFragment } from "../utils/sqlTag";
import { attachWhereValueTransform } from "./WhereValueTransform";
import { BaseRepository } from "./BaseRepository";
import { BaseEntityManager } from "./BaseEntityManager";
import { QueryResult } from "../types/QueryResult";
import { EntityResult } from "../types/EntityResult";
import { DeleteResult } from "../types/DeleteResult";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { BaseRawQueryBuilder } from "./BaseRawQueryBuilder";
import { ResultTransformerFactory } from "./ResultTransformerFactory";
import {
  DatabaseClientOptions,
  normalizeSynchronizePolicy,
  UnknownWriteKeyPolicy,
} from "./DatabaseClientOptions";
import { MetadataContext } from "../metadata/MetadataContext";
import { EntityValidator } from "./EntityValidator";
import {
  EntityEventEmitter,
  EntityEventType,
  EntityEventListener,
} from "./EntityEventEmitter";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import {
  assertKnownColumn,
  buildColumnNameScope,
  collectUnknownWriteKeys,
  ColumnNameScope,
  validateUpdateDataIdentifiers,
  validateWhereIdentifiers,
} from "./ColumnNameValidator";
import { closestIdentifier } from "../utils/closestIdentifier";
import { OptimisticLockError } from "../errors/OptimisticLockError";
import { PrimaryKeyNotFoundError } from "../errors/PrimaryKeyNotFoundError";
import { isScopeExempt } from "./entity-manager/scope-exemption";
import {
  assertEntityClassArgument,
  listKnownEntityNames,
} from "./entity-manager/EntityArgumentGuard";
import { DeleteWithoutConditionsError } from "../errors/DeleteWithoutConditionsError";
import { EntityNotFoundError } from "../errors/EntityNotFoundError";
import { COMPUTED_COLUMN_TOKEN, ComputedColumnMetadata } from "../decorators/ComputedColumn";
import {
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
  DeleteEvent,
} from "./EntitySubscriber";
import { QueryTracker, QueryLogEntry } from "./QueryTracker";
import { ColumnTypeRegistry } from "./ColumnTypeRegistry";
import { defaultJsonColumnWrite, isJsonColumnType } from "./JsonColumnTransformer";
import { assertColumnBindValue } from "./BindValueGuard";
import {
  CursorPaginationOption,
  CursorPaginationResult,
  encodeCursor,
  decodeCursor,
  normalizePageSize,
} from "./CursorPagination";
import {
  PagePaginationOption,
  PagePaginationResult,
  normalizePage,
} from "./PagePagination";
import { ExplainResult } from "./ExplainResult";
import {
  ReplicationRouter,
  ReplicationNodeConfig,
} from "../dialects/ReplicationRouter";
import { transactionStorage } from "../decorators/Transactional";

// Extracted handler classes
import { EntityManagerInternals } from "./EntityManagerInternals";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { buildPropertyToColumnMap as buildSharedPropertyToColumnMap } from "./PropertyColumnMap";
import { ReplicationManager } from "./ReplicationManager";
import { CascadeHandler } from "./CascadeHandler";
import { RelationLoader } from "./RelationLoader";
import { SchemaRegistrar } from "./SchemaRegistrar";
import { ExplainQueryHandler } from "./ExplainQueryHandler";
import { AggregateQueryHandler } from "./AggregateQueryHandler";
import { TenantQueryStrategy } from "./TenantQueryStrategy";
import { StingerloomPlugin } from "./plugin/StingerloomPlugin";
import { PluginContext } from "./plugin/PluginContext";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { NamingStrategy } from "./generators/NamingStrategy";
import { createAliasRef, createEntitySqlRef, AliasRef, SqlRef } from "./SqlRef";
import { InheritanceResolver } from "./InheritanceResolver";
import type { WriteBuffer } from "./plugin/buffer/WriteBuffer";
import type { BufferPluginOptions } from "./plugin/buffer/BufferPreview";
import type { RawPipeline, RawPipelineOptions } from "./plugin/raw-pipeline/RawPipeline";
import { createDialectExpression } from "../dialects/DialectExpression";
import { SelectQueryBuilder, isEntityRef } from "./SelectQueryBuilder";
import type { EntityRef } from "./SelectQueryBuilder";
import { UpdateQueryBuilder } from "./UpdateQueryBuilder";
import {
  InsertQueryBuilder,
  type InsertBuilderSpec,
} from "./InsertQueryBuilder";
import {
  CompiledQuery,
  isPlaceholder,
  p as createPlaceholder,
  PlaceholderMarker,
} from "./CompiledQuery";
import { QueryResultCache } from "./cache/QueryResultCache";
import { DmlSqlBuilder } from "./entity-manager/DmlSqlBuilder";
import { WriteExecutor } from "./entity-manager/WriteExecutor";
import { ReadExecutor } from "./entity-manager/ReadExecutor";
import { RelationExecutor } from "./entity-manager/RelationExecutor";
import { EntityFactory } from "./entity-manager/EntityFactory";
import { DeepPartial } from "../types/DeepPartial";
import { MetadataViewFactory } from "./entity-manager/MetadataViewFactory";
import { TenantScopeManager } from "./entity-manager/TenantScopeManager";
import { SubscriberRegistry } from "./entity-manager/SubscriberRegistry";
import { PluginManager } from "./entity-manager/PluginManager";
import { TransactionRunner } from "./entity-manager/TransactionRunner";
import { RawQueryRunner } from "./entity-manager/RawQueryRunner";
import { applyNamingStrategyToEntities } from "./entity-manager/applyNamingStrategy";
import { ConnectionLifecycle } from "./entity-manager/ConnectionLifecycle";

// ── Extracted types & internal utilities (entity-manager/) ──
import type {
  RefSpec,
  RefTuple,
  EntityMetadataView,
  ColumnMetadataView,
  RelationMetadataView,
  TransactionOptions,
  ExecuteTransactionOptions,
} from "./entity-manager/types";

// Re-export the public types so `export * from "./core"` keeps the public API
// surface byte-identical after the move into entity-manager/types.ts.
export type {
  RefSpec,
  RefTuple,
  EntityMetadataView,
  ColumnMetadataView,
  RelationMetadataView,
  TransactionOptions,
} from "./entity-manager/types";

export class EntityManager implements BaseEntityManager {
  private _entities: ClazzType<any>[] = [];
  private readonly logger = new Logger(EntityManager.name);
  private driver?: ISqlDriver;
  private dataSource?: IDataSource;
  private dirtyEntities: Set<InstanceType<ClazzType<any>>> = new Set();
  private txDirtyEntities: WeakMap<TransactionSessionManager, Set<InstanceType<ClazzType<any>>>> = new WeakMap();
  private readonly eventEmitter = new EntityEventEmitter();
  private readonly subscriberRegistry = new SubscriberRegistry();
  private readonly cursorPkWarned = new Set<string>();
  /**
   * `unknownWriteKeys` policy from the registered options; `"warn"` until
   * `register()` / `attach()` runs.
   */
  private unknownWriteKeyPolicy: UnknownWriteKeyPolicy = "warn";
  /** `${entity}.${key}` pairs already reported under the `"warn"` policy. */
  private readonly writeKeyWarned = new Set<string>();

  /**
   * Live view of the registered subscribers (state moved into
   * SubscriberRegistry). Kept as an instance accessor because tests read
   * `em.subscribers` directly; it returns the registry's own array instance,
   * so mutations (`length = 0`) stay in sync.
   */
  private get subscribers(): EntitySubscriber<any>[] {
    return this.subscriberRegistry.subscribers;
  }
  private queryTracker: QueryTracker | null = null;
  private defaultQueryTimeout: number | undefined;
  private queryLoggingEnabled = false;
  private _queryCache: QueryResultCache | undefined;

  /**
   * The connection name this EntityManager uses.
   * In a multi-database setup each EntityManager instance may have a different connectionName.
   * Defaults to 'default'.
   */
  private connectionName = "default";

  /**
   * True once `attach()` has bound this EM to a pre-existing DatabaseClient
   * connection. Forces `_ctx.getSynchronize()` to return `false` regardless
   * of the stored options, so an attached EM can never re-DDL — the original
   * registering EM owns the schema (#294).
   */
  private isAttached = false;

  /**
   * The connected DB type, cached at connect() time (used for isMySqlFamily/isPostgres branching).
   */
  private dbType: IDatabaseType | undefined;

  // ── Plugin System ──────────────────────────────────────────
  static readonly PLUGIN_PLACEHOLDER = Symbol.for("STG_PLUGIN_PLACEHOLDER");
  /** Method names that are stub placeholders and can be overridden by plugins */
  private static readonly PLUGIN_PLACEHOLDERS = new Set<string>(["buffer", "pipe"]);

  /**
   * Register a method name as a plugin placeholder, allowing plugins to override it.
   */
  static registerPluginPlaceholder(name: string): void {
    EntityManager.PLUGIN_PLACEHOLDERS.add(name);
  }

  // ── Extracted handlers ──────────────────────────────────────────

  private readonly resolver = new RelationMetadataResolver();
  private readonly inheritanceResolver = new InheritanceResolver();
  private readonly replication = new ReplicationManager();

  /**
   * Per-query property→column map cache: merged-metadata-view identity →
   * entity metadata object → map. Both levels are WeakMaps so dropped layers
   * and replaced merged views are GC'd. See buildPropertyToColumnMap().
   */
  private readonly propToColCache = new WeakMap<
    object,
    WeakMap<object, Map<string, string>>
  >();

  /**
   * Classes already approved by {@link assertEntityInScope}. Replaced whenever
   * `_entities` is reassigned (connect/attach), so a re-registration cannot
   * serve stale approvals.
   */
  private entityScopeApproved = new WeakSet<ClazzType<any>>();

  /**
   * Rejects a first argument that is not an entity class — an instance
   * (`em.find(new User())`), an undecorated class, `undefined` from a
   * circular import, a thunk or uncalled factory, a table-name string — with
   * a message that names the mistake (see `EntityArgumentGuard`). Downstream
   * metadata resolution used to report these as `Entity metadata for
   * "undefined" does not exist` or a bare TypeError.
   *
   * Classes approved once are remembered in `entityScopeApproved`, so the
   * accepted path costs a WeakSet lookup.
   */
  private assertEntityArgument(entity: unknown, method: string): void {
    if (this.entityScopeApproved.has(entity as ClazzType<any>)) return;
    assertEntityClassArgument(entity, method, {
      connectionName: this.connectionName,
      registeredEntities: () => listKnownEntityNames(this._entities),
      // Whatever resolves downstream (layered store, Reflect fallback, a
      // test double) is accepted here too — the guard never rejects a class
      // the executors would have served.
      hasMetadata: (cls) =>
        this.resolver.resolveEntityMetadata(cls as ClazzType<any>) !== null,
    });
  }

  /**
   * Fail fast when a scoped EntityManager (non-empty `entities` array) is used
   * with an entity class outside its scope. Decorator side effects register
   * metadata globally, so such a query used to resolve metadata fine and only
   * die on the first SQL with a raw "no such table" — the schema sync had
   * (correctly) skipped the out-of-scope entity's DDL.
   *
   * Runs {@link assertEntityArgument} first, so the argument-shape check
   * applies to unscoped EntityManagers too.
   *
   * Called from the root public entry points only. Cascade traversal
   * (`CascadeHandler` via `_ctx.save`/`_ctx.saveWithSession`/`_ctx.delete`)
   * deliberately bypasses the scope part: a relation target reached only
   * through a cascade can legitimately live outside the scope of an
   * `attach()`ed EntityManager whose tables another registration owns.
   */
  private assertEntityInScope<T>(entity: ClazzType<T>, method: string): void {
    if (this.entityScopeApproved.has(entity)) return;
    this.assertEntityArgument(entity, method);
    if (this._entities.length === 0) {
      this.entityScopeApproved.add(entity); // unscoped: every entity allowed
      return;
    }
    if (isScopeExempt()) return; // cascade traversal — see scope-exemption.ts
    if (this.isInEntityScope(entity)) {
      this.entityScopeApproved.add(entity);
      return;
    }
    throw new EntityMetadataNotFoundError(entity.name, {
      connectionName: this.connectionName,
      registeredEntities: listKnownEntityNames(this._entities),
    });
  }

  /**
   * An entity is in scope when it is listed in `_entities` or shares an
   * inheritance chain (STI/TPT/TPC) with a listed class — querying a child of
   * a scoped parent (or the parent of scoped children) is a polymorphic query
   * against tables this connection owns.
   */
  private isInEntityScope(entity: ClazzType<any>): boolean {
    if (this._entities.includes(entity)) return true;
    for (
      let parent = Object.getPrototypeOf(entity);
      typeof parent === "function" && parent.prototype;
      parent = Object.getPrototypeOf(parent)
    ) {
      if (this._entities.includes(parent)) return true;
    }
    for (const scoped of this._entities) {
      for (
        let parent = Object.getPrototypeOf(scoped);
        typeof parent === "function" && parent.prototype;
        parent = Object.getPrototypeOf(parent)
      ) {
        if (parent === entity) return true;
      }
    }
    return false;
  }

  /** @internal Adapter that exposes EntityManager internals to the extracted handler classes. */
  private readonly _ctx: EntityManagerInternals = {
    wrap: (col) => this.wrap(col),
    wrapTable: (tableName) => this.wrapTable(tableName),
    isMySqlFamily: () => this.isMySqlFamily(),
    isPostgres: () => this.isPostgres(),
    isSqlite: () => this.isSqlite(),
    getDbType: () => this.dbType,
    getDriver: () => this.driver,
    getManager: () => this,
    getLogger: () => this.logger,
    getResolver: () => this.resolver,
    getCascadeHandler: () => this.cascadeHandler,
    getInheritanceResolver: () => this.inheritanceResolver,
    getEventEmitter: () => this.eventEmitter,
    getRelationLoader: () => this.relationLoader,
    getAggregateHandler: () => this.aggregateHandler,
    getDefaultQueryTimeout: () => this.defaultQueryTimeout,
    getQueryCache: () => this.lifecycle.resolveQueryCache(),
    peekQueryCache: () => this._queryCache,
    warnIfNonSortablePk: (n, pk) => this.warnIfNonSortablePk(n, pk),
    resolveLockSuffix: (lock) => this.resolveLockSuffix(lock),
    getEntities: () => this._entities,
    getSynchronize: () => {
      if (this.isAttached) return false;
      const raw = this.client.getOptions(this.connectionName).synchronize;
      // Surface the underlying mode for legacy callers; the policy form is
      // exposed via getSynchronizePolicy().
      if (raw === undefined || raw === false) return false;
      if (raw === true || raw === "safe" || raw === "dry-run") return raw;
      return raw.mode;
    },
    getSynchronizePolicy: () =>
      this.isAttached
        ? normalizeSynchronizePolicy(false)
        : normalizeSynchronizePolicy(
            this.client.getOptions(this.connectionName).synchronize,
          ),
    getDialect: () => {
      if (this.isMySqlFamily()) return "mysql" as const;
      if (this.isPostgres()) return "postgres" as const;
      return "sqlite" as const;
    },
    getSchema: () => this.client.getOptions(this.connectionName).schema,
    getConnection: () => this.connection,
    executeInTransaction: (fn, s, r, o) => this.executeInTransaction(fn, s, r, o),
    executeReadOnly: (fn, opts) => this.executeReadOnly(fn, opts),
    beginTrackQuery: () => this.beginTrackQuery(),
    trackQuery: (e, s, m) => this.trackQuery(e, s, m),
    getConnectionName: () => this.connectionName,
    getTenantStrategy: () => this.tenantScope.strategy,
    notifyTransactionSubscribers: (m) => this.notifyTransactionSubscribers(m),
    notifyPluginBeforeTransaction: (iso) => this.notifyPluginBeforeTransaction(iso),
    notifyPluginAfterTransaction: (c) => this.notifyPluginAfterTransaction(c),
    clearTxDirtyEntities: (s) => {
      this.txDirtyEntities.delete(s);
    },
    warnIfRawQueryBypassesTenant: () => this.warnIfRawQueryBypassesTenant(),
    getReadNode: (u) => this.getReadNode(u),
    getNameStrategy: (c) => this.getNameStrategy(c),
    resolveSelectColumns: (s) => this.resolveSelectColumns(s),
    markDirty: (e) => {
      const txSession = transactionStorage.getStore();
      if (txSession) {
        let set = this.txDirtyEntities.get(txSession);
        if (!set) {
          set = new Set();
          this.txDirtyEntities.set(txSession, set);
        }
        set.add(e);
      } else {
        this.dirtyEntities.add(e);
      }
    },
    findInternal: (e, o, s) => this.findInternal(e, o, s),
    findOneInternal: (e, o, s) => this.findOneInternal(e, o, s),
    save: (e, i) => this.save(e, i),
    saveWithSession: (e, i, s) => this.finishWrite(e, this.writeExecutor.saveInternal(e, i, s)),
    find: (e, o) => this.find(e, o),
    findOne: (e, o) => this.findOne(e, o),
    findAndCount: (e, o) => this.findAndCount(e, o),
    delete: (e, c) => this.delete(e, c),
    getTenantColumnConfig: () => this.tenantColumnConfig,
    resolveEntitySchema: (e) => this.tenantScope.resolveEntitySchema(e),
    pinTableSchema: (t, s) => this.tenantScope.pinTableSchema(t, s),
    buildTenantWhereClause: (e, alias, target) =>
      this.buildTenantWhereClause(e, alias, target),
    buildPropertyToColumnMap: (m) => this.buildPropertyToColumnMap(m),
    propKey: (col) => this.propKey(col),
    applyWriteTransform: (col, v, site) =>
      this.applyWriteTransform(col, v, site),
    applyTenantColumnOnInsert: (e, i) => this.applyTenantColumnOnInsert(e, i),
    assertTenantColumnOnUpdate: (e, i) => this.assertTenantColumnOnUpdate(e, i),
    assertTenantColumnNotInSetColumns: (e, c) =>
      this.tenantScope.assertTenantColumnNotInSetColumns(e, c),
    resolveTenantColumnName: (e) => this.resolveTenantColumnName(e),
    warnTenantUpsertSuppressed: (e, c) =>
      this.tenantScope.warnTenantUpsertSuppressed(e, c),
    getComputedColumnNames: (e) => this.getComputedColumnNames(e),
    validateCriteriaKeys: (m, c, n, clause) =>
      this.validateCriteriaKeys(m, c, n, clause),
    validateUpdateDataKeys: (m, d, n) => this.validateUpdateDataKeys(m, d, n),
    validateWriteInputKeys: (e, m, items, method) =>
      this.validateWriteInputKeys(e, m, items, method),
    hasEagerRelations: (e) => this.hasEagerRelations(e),
    hasSubscriberFor: (e, m) => this.hasSubscriberFor(e, m),
    notifySubscribers: (e, m, a) => this.notifySubscribers(e, m, a),
  };

  private readonly dmlSqlBuilder = new DmlSqlBuilder(this._ctx);
  private readonly cascadeHandler = new CascadeHandler(this.resolver, this._ctx);
  private readonly relationLoader = new RelationLoader(this.resolver, this._ctx);
  private schemaRegistrar = new SchemaRegistrar(this.resolver, this._ctx);
  private readonly explainHandler = new ExplainQueryHandler(this.resolver, this._ctx);
  private readonly aggregateHandler = new AggregateQueryHandler(this.resolver, this._ctx);
  private readonly writeExecutor = new WriteExecutor(this._ctx);
  private readonly readExecutor = new ReadExecutor(this._ctx);
  private readonly relationExecutor = new RelationExecutor(this._ctx);
  private readonly entityFactory = new EntityFactory(this._ctx);
  private readonly metadataViewFactory = new MetadataViewFactory(this._ctx);
  private readonly tenantScope = new TenantScopeManager(this._ctx);
  private readonly transactionRunner = new TransactionRunner(this._ctx);
  private readonly rawQueryRunner = new RawQueryRunner(this._ctx);
  private readonly pluginManager = new PluginManager(this._ctx, {
    isPlaceholder: (name) => EntityManager.PLUGIN_PLACEHOLDERS.has(name),
    reservedMemberNames: () =>
      Object.getOwnPropertyNames(EntityManager.prototype),
    registerPlaceholder: (name) =>
      EntityManager.registerPluginPlaceholder(name),
  });
  private readonly lifecycle = new ConnectionLifecycle(this._ctx, {
    getClient: () => this.client,
    setConnectionName: (name) => {
      this.connectionName = name;
    },
    setEntities: (entities) => {
      this._entities = entities;
      this.entityScopeApproved = new WeakSet();
    },
    markAttached: () => {
      this.isAttached = true;
    },
    setDbType: (dbType) => {
      this.dbType = dbType;
    },
    setDriver: (driver, dataSource) => {
      this.driver = driver;
      this.dataSource = dataSource;
    },
    setDefaultQueryTimeout: (ms) => {
      this.defaultQueryTimeout = ms;
    },
    setUnknownWriteKeyPolicy: (policy) => {
      this.unknownWriteKeyPolicy = policy;
    },
    setQueryLoggingEnabled: (enabled) => {
      this.queryLoggingEnabled = enabled;
    },
    setQueryTracker: (tracker) => {
      this.queryTracker = tracker;
    },
    setQueryCache: (cache) => {
      this._queryCache = cache;
    },
    useNamingStrategy: (strategy) => {
      this.schemaRegistrar = new SchemaRegistrar(this.resolver, this._ctx, strategy);
    },
    registerEntities: () => this.schemaRegistrar.registerEntities(),
    configureTenantScope: (options) => this.tenantScope.configure(options),
    initializeReplication: (config) => this.replication.initialize(config),
    installPlugin: (plugin) => {
      this.extend(plugin);
    },
    getQueryTracker: () => this.queryTracker,
    shutdownPlugins: () => this.pluginManager.shutdownAll(),
    clearRuntimeState: () => {
      this.removeAllListeners();
      this.subscribers.length = 0;
      this.dirtyEntities.clear();
      this.cursorPkWarned.clear();
      this.writeKeyWarned.clear();
      this.rawQueryTenantWarned.clear();
      this.schemaRegistrar.releaseInjectedTenantColumns();
    },
    shutdownReplication: () => this.replication.shutdown(),
  });

  // ── Live tenant-state accessors ─────────────────────────────────
  // State moved into TenantScopeManager; these stay as instance accessors
  // because tests reassign `em.tenantStrategy` and read `em.rawQueryTenantWarned`
  // directly on the EntityManager.

  private get tenantStrategy(): TenantQueryStrategy {
    return this.tenantScope.strategy;
  }

  private set tenantStrategy(strategy: TenantQueryStrategy) {
    this.tenantScope.strategy = strategy;
  }

  private get rawQueryTenantWarned(): Set<string> {
    return this.tenantScope.rawQueryWarnedCallSites;
  }

  private get tenantColumnConfig(): {
    name: string;
    type: "varchar" | "uuid" | "int" | "bigint";
    length?: number;
  } | null {
    return this.tenantScope.columnConfig;
  }

  private set tenantColumnConfig(config: {
    name: string;
    type: "varchar" | "uuid" | "int" | "bigint";
    length?: number;
  } | null) {
    this.tenantScope.columnConfig = config;
  }

  // ── Lifecycle ──────────────────────────────────────────

  public async register(
    databaseClientOptions: DatabaseClientOptions,
    connectionName = "default",
  ) {
    await this.lifecycle.register(databaseClientOptions, connectionName);
  }

  /**
   * Resolve table and column names on the supplied entities through
   * `strategy`, mutating their decorator metadata in place.
   *
   * Exposed for tools that work with entity metadata outside an active
   * `EntityManager` — most importantly the migration CLI, which needs the
   * same naming applied so `migrate:generate` does not diff camelCase
   * property names against snake_case DB columns.
   *
   * Idempotent: re-running with the same strategy is a no-op because the
   * `nameExplicit` flag is preserved and column names are already
   * snake-cased on the second pass.
   */
  static applyNamingStrategyToEntities(
    entities: Iterable<ClazzType<any>>,
    strategy?: NamingStrategy,
  ): void {
    applyNamingStrategyToEntities(entities, strategy);
  }

  get client() {
    return DatabaseClient.getInstance();
  }

  get connection() {
    // Branch on whether getConnection(name) is supported (backward compat)
    const c = this.client as any;
    if (typeof c.getConnection === "function") {
      return c.getConnection(this.connectionName);
    }
    return c.getConnection();
  }

  /**
   * Returns the connection name this EntityManager uses.
   */
  getConnectionName(): string {
    return this.connectionName;
  }

  public async connect(
    databaseClientOptions: DatabaseClientOptions,
    connectionName = "default",
  ) {
    await this.lifecycle.connect(databaseClientOptions, connectionName);
  }

  /**
   * Reuse a connection that has already been registered with `DatabaseClient`
   * (typically by another `EntityManager` or by `DatabaseClient.connect()`
   * directly), and bring this `EntityManager` instance online against it
   * **without opening a new pool**.
   *
   * This is the safe path for the `tenantStrategy: "database"` router when a
   * `tenantDatabaseResolver` returns an already-registered connection name as
   * a string: calling `register()` (which calls `connect()` → `client.connect()`)
   * would instead create a brand-new connector and overwrite the existing one
   * in `DatabaseClient`'s map without closing it, leaking the previous pool.
   *
   * Schema sync is intentionally NOT run here — the caller that originally
   * registered the connection is expected to own the schema. Naming strategy
   * and per-EM entity registration are still applied so this EM behaves the
   * same as one created via `register()`.
   */
  public async attach(
    connectionName: string,
    overrides?: Partial<DatabaseClientOptions>,
  ) {
    await this.lifecycle.attach(connectionName, overrides);
  }

  /**
   * The query result cache for this EntityManager. `undefined` when caching
   * is disabled via `register({ cache: false })`.
   *
   * Use it for manual control:
   * ```ts
   * await em.queryCache?.invalidate(Product);       // by entity
   * await em.queryCache?.invalidate("dashboard");   // by user tag
   * await em.queryCache?.clear();
   * em.queryCache?.stats;                            // { hits, misses, entries }
   * ```
   */
  get queryCache(): QueryResultCache | undefined {
    return this.lifecycle.resolveQueryCache();
  }

  /**
   * Completes a write API call: after the write succeeds, drops every cached
   * row set whose tables the write could have touched. Uses the peeked cache
   * (never creates one), so workloads that never cache pay nothing. Runs on
   * cascade re-entry too — each cascaded entity invalidates its own closure.
   */
  private async finishWrite<R>(
    entity: ClazzType<any>,
    work: Promise<R>,
  ): Promise<R> {
    const result = await work;
    const cache = this._queryCache;
    if (cache) await cache.invalidateEntity(entity);
    return result;
  }

  /**
   * Cleans up resources and shuts down.
   */
  public async propagateShutdown(options?: {
    gracefulTimeoutMs?: number;
    closeConnections?: boolean;
  }): Promise<boolean> {
    return this.lifecycle.shutdown(options);
  }

  getNameStrategy<T>(clazz: ClazzType<T>): string {
    return clazz.name;
  }

  // ── QueryTracker ──────────────────────────────────────────

  /** Engine delegator — implementation lives in {@link ConnectionLifecycle}. */
  private initQueryTracker(options: DatabaseClientOptions): void {
    this.lifecycle.initQueryTracker(options);
  }

  getQueryLog(): ReadonlyArray<QueryLogEntry> {
    return this.queryTracker?.getLog() ?? [];
  }

  getQueryTracker(): QueryTracker | null {
    return this.queryTracker;
  }

  private beginTrackQuery(): void {
    this.queryTracker?.beginQuery();
  }

  private trackQuery(
    entityName: string,
    sqlText: string,
    durationMs: number,
  ): void {
    if (this.queryLoggingEnabled) {
      this.logger.debug(`[${entityName}] ${sqlText} (+${durationMs}ms)`);
    }
    this.queryTracker?.endQuery();
    this.queryTracker?.track(entityName, sqlText, durationMs);
  }

  // ── Plugin Query Hooks (#228) ─────────────────────────────

  /** @internal Notify installed plugins before a query executes. */
  notifyPluginBeforeQuery(queryInfo: import("./plugin/StingerloomPlugin").QueryInfo): import("./plugin/StingerloomPlugin").QueryInfo {
    return this.pluginManager.notifyBeforeQuery(queryInfo);
  }

  /** @internal Notify installed plugins after a query executes. */
  notifyPluginAfterQuery(queryInfo: import("./plugin/StingerloomPlugin").QueryInfo, result: any, durationMs: number): void {
    this.pluginManager.notifyAfterQuery(queryInfo, result, durationMs);
  }

  /** @internal Notify installed plugins before a transaction. */
  private notifyPluginBeforeTransaction(isolationLevel?: string): void {
    this.pluginManager.notifyBeforeTransaction(isolationLevel);
  }

  /** @internal Notify installed plugins after a transaction. */
  private notifyPluginAfterTransaction(committed: boolean): void {
    this.pluginManager.notifyAfterTransaction(committed);
  }

  // ── Replication delegation ──────────────────────────────────────

  getReadNode(useMaster?: boolean): ReplicationNodeConfig | null {
    return this.replication.getReadNode(useMaster);
  }

  getWriteNode(): ReplicationNodeConfig | null {
    return this.replication.getWriteNode();
  }

  get isReplicationEnabled(): boolean {
    return this.replication.isEnabled;
  }

  getReplicationRouter(): ReplicationRouter | null {
    return this.replication.getRouter();
  }

  // ── Events / Subscribers ────────────────────────────────────────

  on(event: EntityEventType, listener: EntityEventListener): void {
    this.eventEmitter.on(event, listener);
  }

  off(event: EntityEventType, listener: EntityEventListener): void {
    this.eventEmitter.off(event, listener);
  }

  removeAllListeners(): void {
    this.eventEmitter.removeAllListeners();
  }

  addSubscriber(subscriber: EntitySubscriber<any>): void {
    this.subscriberRegistry.add(subscriber);
  }

  removeSubscriber(subscriber: EntitySubscriber<any>): void {
    this.subscriberRegistry.remove(subscriber);
  }

  // ── Plugin System ──────────────────────────────────────────

  /**
   * Install a plugin on this EntityManager instance.
   * Idempotent — installing the same plugin name twice is a no-op.
   *
   * @returns `this` with the plugin's API methods mixed in
   */
  extend<TApi extends Record<string, any>>(
    plugin: StingerloomPlugin<TApi>,
  ): this & TApi {
    this.pluginManager.extend(plugin);
    return this as this & TApi;
  }

  /**
   * Register a custom column type with per-dialect SQL mappings.
   *
   * @example
   * ```ts
   * em.registerColumnType("geometry", {
   *   mysql: "GEOMETRY",
   *   postgres: "geometry(Point, 4326)",
   *   sqlite: "TEXT",
   *   transformer: {
   *     to: (value) => `POINT(${value.x} ${value.y})`,
   *     from: (raw) => parsePoint(raw),
   *   },
   * });
   * ```
   */
  registerColumnType(name: string, definition: import("./ColumnTypeRegistry").CustomColumnTypeDefinition): void {
    ColumnTypeRegistry.getInstance().register(name, definition);
  }

  /**
   * Check if a plugin with the given name is installed.
   */
  hasPlugin(name: string): boolean {
    return this.pluginManager.has(name);
  }

  /**
   * Get a plugin's API object by name.
   * Returns undefined if the plugin is not installed.
   */
  getPluginApi<T = unknown>(name: string): T | undefined {
    return this.pluginManager.getApi<T>(name);
  }

  /**
   * Create a WriteBuffer instance for tracking entity changes and batch flush.
   * Requires the buffer plugin to be installed first via `em.extend(bufferPlugin())`.
   *
   * @param opts — Per-buffer option overrides (e.g. `{ logging: true }`)
   * @throws OrmError with BUFFER_NOT_INSTALLED if the buffer plugin is not installed.
   */
  buffer(opts?: BufferPluginOptions): WriteBuffer {
    throw new OrmError(
      OrmErrorCode.BUFFER_NOT_INSTALLED,
      "buffer() requires the buffer plugin to be installed",
      "Call em.extend(bufferPlugin()) before using em.buffer()",
    );
  }

  /**
   * Create a RawPipeline for large-data processing without entity transformation.
   * Requires the raw-pipeline plugin to be installed first via `em.extend(rawPipelinePlugin())`.
   *
   * @param entity - The entity class (used for table name / column resolution)
   * @param options - FindOption + batchSize
   * @throws OrmError if the raw-pipeline plugin is not installed.
   */
  pipe<T>(_entity: ClazzType<T>, _options?: RawPipelineOptions<T>): RawPipeline<T> {
    throw new OrmError(
      OrmErrorCode.PLUGIN_DEPENDENCY_MISSING,
      "pipe() requires the raw-pipeline plugin to be installed",
      "Call em.extend(rawPipelinePlugin()) before using em.pipe()",
    );
  }

  /**
   * Create or return the cached PluginContext for this EntityManager.
   * Engine delegator — implementation lives in {@link PluginManager}; kept on
   * the facade because tests call `(em as any).getPluginContext()`.
   */
  private getPluginContext(): PluginContext {
    return this.pluginManager.getContext();
  }

  /**
   * Engine delegator — implementation lives in {@link SubscriberRegistry}.
   * Kept on the facade so `_ctx` routing and instance-level reassignment
   * (`(em as any).notifySubscribers = ...`) keep working.
   */
  private async notifySubscribers<T>(
    entityClass: new (...args: any[]) => T,
    method: keyof EntitySubscriber<T>,
    arg?: any,
  ): Promise<void> {
    return this.subscriberRegistry.notify(entityClass, method, arg);
  }

  /**
   * #371: fires `afterLoad` subscribers for entities loaded outside the
   * find/findOne paths (SelectQueryBuilder getMany/getOne entity results).
   * Mirrors the find-path notification: one call per entity, keyed by the
   * requested entity class. Raw/partial reads must not call this.
   *
   * @internal
   */
  async emitAfterLoad<T>(
    entityClass: ClazzType<T>,
    entities: T | T[] | null | undefined,
  ): Promise<void> {
    return this.subscriberRegistry.emitAfterLoad(
      entityClass,
      entities,
      (e, m, a) => this.notifySubscribers(e, m, a),
    );
  }

  /** Engine delegator — implementation lives in {@link SubscriberRegistry}. */
  private hasSubscriberFor<T>(
    entityClass: new (...args: any[]) => T,
    method: keyof EntitySubscriber<T>,
  ): boolean {
    return this.subscriberRegistry.hasSubscriberFor(entityClass, method);
  }

  /** Engine delegator — implementation lives in {@link SubscriberRegistry}. */
  private async notifyTransactionSubscribers(
    method: keyof EntitySubscriber<any>,
  ): Promise<void> {
    return this.subscriberRegistry.notifyTransaction(method);
  }

  // ── CRUD: Read ────────────────────────────────────────────

  async findOne<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T | null> {
    this.assertEntityInScope(entity, "findOne");
    return this.readExecutor.findOne(entity, findOption);
  }

  /**
   * Engine delegator — the implementation lives in {@link ReadExecutor}. Kept on
   * the facade so internal callers and tests can intercept it via `em`.
   */
  private async findInternal<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
    existingSession?: TransactionSessionManager,
  ): Promise<EntityResult<T>> {
    return this.readExecutor.findInternal(entity, findOption, existingSession);
  }

  private async findOneInternal<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
    existingSession?: TransactionSessionManager,
  ): Promise<T | null> {
    return this.readExecutor.findOneInternal(entity, findOption, existingSession);
  }

  /**
   * Retrieves a single entity matching `where`.
   *
   * Filter-first shorthand for `findOne(entity, { where })` — drops the
   * options-object ceremony for the common "find by these fields" case,
   * matching the filter-first shape of `delete`/`update`. For relations,
   * ordering, pagination, locking, etc., use {@link findOne} with a full
   * `FindOption`.
   *
   * @example
   * ```ts
   * const user = await em.findOneBy(User, { id: 1 });
   * const active = await em.findOneBy(User, { email, status: "active" });
   * ```
   */
  async findOneBy<T>(
    entity: ClazzType<T>,
    where: WhereClause<T> | WhereClause<T>[],
  ): Promise<T | null> {
    this.assertEntityInScope(entity, "findOneBy");
    return this.readExecutor.findOneBy(entity, where);
  }

  /**
   * Retrieves a single entity matching the given options.
   * Throws `EntityNotFoundError` if no entity is found.
   *
   * @example
   * ```ts
   * const user = await em.findOneOrFail(User, { where: { id: 1 } });
   * ```
   */
  async findOneOrFail<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T> {
    const result = await this.findOne(entity, findOption);
    if (result === null || result === undefined) {
      throw new EntityNotFoundError(entity.name);
    }
    return result;
  }

  /**
   * Filter-first counterpart of {@link findOneOrFail}: retrieves the single
   * entity matching `where` and throws `EntityNotFoundError` if none is found.
   *
   * Completes the read grid — `findOneBy` is to `findOne` what
   * `findOneByOrFail` is to `findOneOrFail`, dropping the options-object
   * ceremony for the common "get this row or blow up" case.
   *
   * @example
   * ```ts
   * const user = await em.findOneByOrFail(User, { id: 1 });
   * ```
   */
  async findOneByOrFail<T>(
    entity: ClazzType<T>,
    where: WhereClause<T> | WhereClause<T>[],
  ): Promise<T> {
    const result = await this.findOneBy(entity, where);
    if (result === null || result === undefined) {
      throw new EntityNotFoundError(entity.name);
    }
    return result;
  }

  async find<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<T[]> {
    this.assertEntityInScope(entity, "find");
    return this.readExecutor.find(entity, findOption);
  }

  /**
   * Retrieves all entities matching `where`.
   *
   * Filter-first shorthand for `find(entity, { where })`. For relations,
   * ordering, pagination, etc., use {@link find} with a full `FindOption`.
   *
   * @example
   * ```ts
   * const admins = await em.findBy(User, { role: "admin" });
   * ```
   */
  async findBy<T>(
    entity: ClazzType<T>,
    where: WhereClause<T> | WhereClause<T>[],
  ): Promise<T[]> {
    this.assertEntityInScope(entity, "findBy");
    return this.readExecutor.findBy(entity, where);
  }

  /**
   * Retrieves a flat array of a single column's values across matching rows.
   *
   * Convenience over `find(...).map(row => row[column])` for the common
   * "give me all the ids / emails" case. Internally reuses {@link find} with a
   * `select` restricted to `column`, so tenant scoping, soft-delete filtering,
   * and naming-strategy column mapping all apply automatically. Row order
   * matches what `find` returns.
   *
   * @param entity The entity class to query.
   * @param column The property whose values should be collected.
   * @param where Optional filter selecting rows (defaults to every row).
   * @returns A promise resolving to the column values in row order.
   *
   * @example
   * ```ts
   * const ids = await em.pluck(User, "id", { active: true });
   * // -> [1, 2, 3]
   * ```
   */
  async pluck<T, K extends keyof T & string>(
    entity: ClazzType<T>,
    column: K,
    where?: WhereClause<T> | WhereClause<T>[],
  ): Promise<T[K][]> {
    this.assertEntityInScope(entity, "pluck");
    return this.readExecutor.pluck(entity, column, where);
  }

  async findWithCursor<T>(
    entity: ClazzType<T>,
    option: CursorPaginationOption<T> = {},
  ): Promise<CursorPaginationResult<T>> {
    this.assertEntityInScope(entity, "findWithCursor");
    return this.readExecutor.findWithCursor(entity, option);
  }

  async findAndCount<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<[T[], number]> {
    this.assertEntityInScope(entity, "findAndCount");
    return this.readExecutor.findAndCount(entity, findOption);
  }

  /**
   * Returns an AsyncGenerator that yields entities in batches using LIMIT/OFFSET.
   * Works across all dialects without driver-level streaming support.
   *
   * A caller's own `limit` / `take` / `skip` define the overall window the
   * stream covers (same precedence as `find()`); batching happens inside it.
   *
   * @param entity - The entity class
   * @param options - Find options (where, orderBy, relations, etc.)
   * @param batchSize - Number of rows per batch (default: 1000)
   */
  async *stream<T>(
    entity: ClazzType<T>,
    options: FindOption<T> = {},
    batchSize: number = 1000,
  ): AsyncGenerator<T, void, undefined> {
    for await (const batch of this.streamBatch<T>(entity, options, batchSize)) {
      for (const item of batch) {
        yield item;
      }
    }
  }

  /**
   * Streams entities in batches, yielding T[] arrays.
   * Each yielded value is an array of fully-deserialized entities with relations loaded.
   * Suitable for processing large datasets without loading all rows into memory.
   *
   * A caller's own `limit` / `take` / `skip` define the overall window the
   * stream covers, with `find()`'s precedence rules. They used to be
   * overwritten by the internal batch tuple — except `take`, which leaked
   * into every batch's LIMIT while the offset still advanced by `batchSize`,
   * re-yielding rows whenever `take` exceeded the batch size.
   *
   * @param entity - The entity class
   * @param options - FindOption (where, select, relations, orderBy, etc.)
   * @param batchSize - Number of rows per batch (default: 1000)
   */
  async *streamBatch<T>(
    entity: ClazzType<T>,
    options: FindOption<T> = {},
    batchSize: number = 1000,
  ): AsyncGenerator<T[], void, undefined> {
    this.assertEntityInScope(entity, "streamBatch");
    const { limit, take, skip, ...rest } = options;

    // Resolve the caller's window with find()'s precedence: a limit tuple
    // sets both bounds (a positive `take` overriding its count); otherwise
    // skip/take pagination; otherwise a plain numeric limit caps the count.
    let offset = 0;
    let remaining = Infinity;
    if (Array.isArray(limit)) {
      offset = limit[0];
      remaining = take && take > 0 ? take : limit[1];
    } else if (skip !== undefined || (take !== undefined && limit === undefined)) {
      offset = skip ?? 0;
      if (take !== undefined) remaining = take;
    } else if (typeof limit === "number") {
      remaining = limit;
    }

    const effectiveBatchSize = Math.max(batchSize, 1);

    while (remaining > 0) {
      const size = Math.min(effectiveBatchSize, remaining);
      const batch = await this.find<T>(entity, {
        ...(rest as FindOption<T>),
        limit: [offset, size],
      });

      if (batch.length === 0) break;

      yield batch;

      remaining -= batch.length;
      if (batch.length < size) break;
      offset += batch.length;
    }
  }

  async findWithPage<T>(
    entity: ClazzType<T>,
    option: PagePaginationOption<T> = {},
  ): Promise<PagePaginationResult<T>> {
    this.assertEntityInScope(entity, "findWithPage");
    return this.readExecutor.findWithPage(entity, option);
  }

  // ── Entity construction (no persistence) ────────────────────

  /**
   * Builds a hydrated entity instance from a plain object **without touching
   * the database**. The result is a real class instance — indistinguishable
   * from one returned by `find` — so class methods, getters, `@Exclude`, and
   * column transformers all apply. Nothing is persisted and no lifecycle hooks
   * run; hand the instance to {@link save} when you want it written.
   *
   * Pass an array to build many instances at once.
   *
   * @example
   * ```ts
   * const user = em.create(User, { name: "Alice", email });
   * user.activate();               // instance methods work
   * await em.save(User, user);     // persist when ready
   *
   * const users = em.create(User, [{ name: "A" }, { name: "B" }]);
   * ```
   */
  create<T>(entity: ClazzType<T>): InstanceType<ClazzType<T>>;
  create<T>(
    entity: ClazzType<T>,
    data: DeepPartial<T>,
  ): InstanceType<ClazzType<T>>;
  create<T>(
    entity: ClazzType<T>,
    data: DeepPartial<T>[],
  ): InstanceType<ClazzType<T>>[];
  create<T>(
    entity: ClazzType<T>,
    data?: DeepPartial<T> | DeepPartial<T>[],
  ): InstanceType<ClazzType<T>> | InstanceType<ClazzType<T>>[] {
    return this.entityFactory.create(entity, data as DeepPartial<T>);
  }

  /**
   * Merges one or more partial patches into an existing entity instance,
   * mutating and returning `target`. Nested plain objects / relations are
   * merged recursively; arrays, `Date`s, and `Buffer`s replace wholesale.
   * `undefined` values are skipped so they never null out an existing field.
   *
   * Purely in-memory — no query, no persistence. Combine with {@link save} to
   * write the result.
   *
   * @example
   * ```ts
   * em.merge(user, { name: "New" }, { status: "active" });
   * ```
   */
  merge<T>(target: T, ...sources: DeepPartial<T>[]): T {
    return this.entityFactory.merge(target, ...sources);
  }

  /**
   * Loads the row identified by the primary key(s) in `partial`, merges the
   * remaining fields of `partial` onto it, and returns the hydrated instance —
   * ready to hand to {@link save} for a read-modify-write update.
   *
   * Returns `undefined` when `partial` lacks a complete primary key or no row
   * matches (mirrors TypeORM). The returned instance is detached: there is no
   * change tracking, so the merge is applied immediately and persists only
   * when you call {@link save}.
   *
   * @example
   * ```ts
   * const patched = await em.preload(User, { id: 1, name: "New name" });
   * if (patched) await em.save(User, patched);
   * ```
   */
  async preload<T>(
    entity: ClazzType<T>,
    partial: DeepPartial<T>,
  ): Promise<InstanceType<ClazzType<T>> | undefined> {
    this.assertEntityInScope(entity, "preload");
    return this.entityFactory.preload(entity, partial);
  }

  // ── CRUD: Write ────────────────────────────────────────────

  async save<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<InstanceType<ClazzType<T>>> {
    this.assertEntityInScope(entity, "save");
    return this.finishWrite(entity, this.writeExecutor.save(entity, item));
  }

  async saveMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<InstanceType<ClazzType<T>>[]> {
    this.assertEntityInScope(entity, "saveMany");
    return this.finishWrite(entity, this.writeExecutor.saveMany(entity, items));
  }

  async insertMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<{ affected: number }> {
    this.assertEntityInScope(entity, "insertMany");
    return this.finishWrite(entity, this.writeExecutor.insertMany(entity, items));
  }

  /**
   * Inserts multiple entities with a single multi-row INSERT and returns the
   * inserted entity instances, in input order, with generated primary keys and
   * database-default columns populated via the `RETURNING` clause.
   *
   * Unlike {@link insertMany} — which only reports an affected-row count and
   * forces a follow-up re-read to obtain generated PKs / DB defaults — this
   * method deserializes the `RETURNING *` rows directly back into entities, so
   * no extra query is required.
   *
   * Requires `INSERT ... RETURNING` support: PostgreSQL (all versions),
   * SQLite 3.35+, and MariaDB 10.5+. MySQL does not support RETURNING and will
   * throw an {@link OrmError} with {@link OrmErrorCode.UNSUPPORTED_DATABASE}
   * before any SQL is built; use {@link saveMany} there instead.
   *
   * @param entity The entity class.
   * @param items The partial entities to insert.
   * @returns The inserted entity instances, in input order.
   */
  async insertManyAndReturn<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<InstanceType<ClazzType<T>>[]> {
    this.assertEntityInScope(entity, "insertManyAndReturn");
    return this.finishWrite(entity, this.writeExecutor.insertManyAndReturn(entity, items));
  }

  // ── CRUD: Delete ────────────────────────────────────────────

  async delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    this.assertEntityInScope(entity, "delete");
    return this.finishWrite(entity, this.writeExecutor.delete(entity, criteria));
  }

  async deleteMany<T>(entity: ClazzType<T>, ids: unknown[]): Promise<DeleteResult> {
    this.assertEntityInScope(entity, "deleteMany");
    return this.finishWrite(entity, this.writeExecutor.deleteMany(entity, ids));
  }

  async clear<T>(entity: ClazzType<T>): Promise<void> {
    this.assertEntityInScope(entity, "clear");
    return this.finishWrite(entity, this.writeExecutor.clear(entity));
  }

  /**
   * Updates rows matching `where` with `data`.
   *
   * Ergonomic single-call form of {@link updateMany}: the filter is the
   * **second positional argument** — mirroring `delete(entity, criteria)` —
   * instead of being nested under an options object. This keeps the "filter
   * the rows to mutate" mental model consistent across `update` and `delete`.
   *
   * Delegates to {@link updateMany}, so it inherits the same empty-WHERE guard
   * (a table-wide update is rejected), tenant scoping, `@UpdateTimestamp`
   * auto-injection, NamingStrategy column mapping, and raw-`Sql` SET-expression
   * support. For ordered/capped updates (`orderBy` + `limit`), use
   * {@link updateMany} directly.
   *
   * @param entity The entity class.
   * @param where The filter selecting rows to update (required, non-empty).
   * @param data The partial data to set on matching rows.
   * @returns `{ affected }` — the number of rows updated.
   *
   * @example
   * ```ts
   * await em.update(User, { id: 1 }, { name: "Alice" });
   * await em.update(Post, { id: 1 }, { viewCount: sql`view_count + 1` });
   * ```
   */
  async update<T>(
    entity: ClazzType<T>,
    where: WhereClause<T>,
    data: UpdateData<T>,
  ): Promise<{ affected: number }> {
    this.assertEntityInScope(entity, "update");
    return this.finishWrite(entity, this.writeExecutor.update(entity, where, data));
  }

  /**
   * Updates multiple entities matching the WHERE condition with the given data.
   *
   * Supports `orderBy` + `limit` for capped, ordered updates (e.g. atomic
   * worker-claim queues). On MySQL/MariaDB this emits native
   * `UPDATE … ORDER BY … LIMIT n`; on PostgreSQL / SQLite it rewrites to
   * `UPDATE … WHERE pk IN (SELECT pk FROM … ORDER BY … LIMIT n)` since those
   * dialects don't accept ORDER BY / LIMIT directly on UPDATE.
   *
   * @param entity The entity class.
   * @param data The partial data to set on matching rows.
   * @param options `where` (required) plus optional `orderBy` and `limit`.
   * @returns The number of affected rows.
   *
   * @example
   * ```ts
   * const result = await em.updateMany(User, { active: true }, { where: { status: 'pending' } });
   * console.log(result.affected); // 42
   *
   * // Capped, ordered claim — atomic on InnoDB
   * await em.updateMany(
   *   Issue,
   *   { claimedBy: workerId },
   *   {
   *     where: { status: 'TODO' },
   *     orderBy: { priority: 'ASC', number: 'ASC' },
   *     limit: 1,
   *   },
   * );
   * ```
   */
  async updateMany<T>(
    entity: ClazzType<T>,
    data: UpdateData<T>,
    options: UpdateManyOptions<T>,
  ): Promise<{ affected: number }> {
    this.assertEntityInScope(entity, "updateMany");
    return this.finishWrite(entity, this.writeExecutor.updateMany(entity, data, options));
  }

  /**
   * Atomically adds `by` to a numeric `column` for every row matching `where`.
   *
   * Emits `UPDATE … SET <col> = <col> + ? WHERE …` so the delta is applied
   * **in the database**, never via a read-modify-write round trip. Concurrent
   * callers therefore can't clobber each other's updates — two simultaneous
   * `increment(Post, { id: 1 }, "viewCount")` calls produce `+2`, not `+1`.
   *
   * Filter-first argument order mirrors {@link update}/{@link delete}. The call
   * delegates to {@link update}, so it inherits the same empty-WHERE guard,
   * tenant scoping, soft-delete semantics, NamingStrategy column mapping, and
   * `@Version` optimistic-lock auto-increment (the version column is bumped in
   * the very same statement).
   *
   * @param entity The entity class.
   * @param where The filter selecting rows to mutate (required, non-empty).
   * @param column The numeric entity property to increment.
   * @param by The amount to add (a finite number, default `1`).
   * @returns `{ affected }` — the number of rows updated.
   *
   * @example
   * ```ts
   * await em.increment(Post, { id: 1 }, "viewCount");      // viewCount += 1
   * await em.increment(Wallet, { userId: 7 }, "balance", 50); // balance += 50
   * ```
   */
  async increment<T>(
    entity: ClazzType<T>,
    where: WhereClause<T>,
    column: keyof T & string,
    by: number = 1,
  ): Promise<{ affected: number }> {
    this.assertEntityInScope(entity, "increment");
    return this.finishWrite(entity, this.writeExecutor.increment(entity, where, column, by));
  }

  /**
   * Atomically subtracts `by` from a numeric `column` for every row matching
   * `where`. The arithmetic counterpart of {@link increment}.
   *
   * Emits `UPDATE … SET <col> = <col> - ? WHERE …`, so the decrement is applied
   * atomically in the database with no read-modify-write race. Delegates to
   * {@link update}, inheriting tenant scoping, soft-delete semantics, and the
   * `@Version` optimistic-lock bump exactly like {@link increment}.
   *
   * @param entity The entity class.
   * @param where The filter selecting rows to mutate (required, non-empty).
   * @param column The numeric entity property to decrement.
   * @param by The amount to subtract (a finite number, default `1`).
   * @returns `{ affected }` — the number of rows updated.
   *
   * @example
   * ```ts
   * await em.decrement(Product, { id: 9 }, "stock");          // stock -= 1
   * await em.decrement(Wallet, { userId: 7 }, "balance", 50); // balance -= 50
   * ```
   */
  async decrement<T>(
    entity: ClazzType<T>,
    where: WhereClause<T>,
    column: keyof T & string,
    by: number = 1,
  ): Promise<{ affected: number }> {
    this.assertEntityInScope(entity, "decrement");
    return this.finishWrite(entity, this.writeExecutor.decrement(entity, where, column, by));
  }

  /**
   * Create an `UpdateQueryBuilder` for the given entity (or `qAlias`).
   *
   * Provides a fluent UPDATE DSL with `.set / .where / .orderBy / .limit /
   * .execute()` that mirrors the qAlias-based predicate style used by
   * `createQueryBuilder()` for SELECT.
   *
   * @example
   * ```ts
   * const i = qAlias(Issue, "i");
   * await em.createUpdateBuilder(i)
   *   .set({ claimedBy: workerId, claimedAt: sql`NOW()` })
   *   .where(i.projectId.eq(projectId))
   *   .andWhere(i.status.in([BACKLOG, TODO]))
   *   .orderBy(i.priority.asc())
   *   .limit(1)
   *   .execute();
   * ```
   */
  createUpdateBuilder<T>(entity: ClazzType<T>, alias?: string): UpdateQueryBuilder<T>;
  createUpdateBuilder<T>(ref: EntityRef<T>): UpdateQueryBuilder<T>;
  createUpdateBuilder<T>(
    entityOrRef: ClazzType<T> | EntityRef<T>,
    alias?: string,
  ): UpdateQueryBuilder<T> {
    const entity: ClazzType<T> = isEntityRef(entityOrRef)
      ? entityOrRef._entity
      : entityOrRef;
    // Before the alias falls back to `entity.name`, so a misused argument is
    // diagnosed instead of dying on `.name` of undefined.
    this.assertEntityInScope(entity, "createUpdateBuilder");
    const aliasName: string = isEntityRef(entityOrRef)
      ? entityOrRef._alias
      : (alias ?? entity.name);
    const meta = this.resolver.resolveEntityMetadata(entity);
    if (!meta) {
      throw new EntityMetadataNotFoundError(entity.name);
    }
    const propMap = this.buildPropertyToColumnMap(meta);
    const dialectExpr = createDialectExpression(this._ctx.getDialect());
    return new UpdateQueryBuilder<T>(
      this,
      entity,
      aliasName,
      propMap,
      dialectExpr,
      (key, dbCol, value) =>
        this.writeExecutor.criteriaSetValue(
          meta,
          entity.name,
          key,
          dbCol,
          value,
          "createUpdateBuilder().set()",
        ),
    );
  }

  /**
   * @internal Used by `UpdateQueryBuilder.build()` — builds the UPDATE SQL
   * with tenant scoping omitted (build-time only). Execution paths add
   * tenant scoping via `executeBuilderUpdate`.
   */
  buildBuilderUpdateSql<T>(
    entity: ClazzType<T>,
    setMap: Sql[],
    whereConditions: Sql[],
    orderBySql: Sql | undefined,
    limit: number | undefined,
  ): Sql {
    return this.writeExecutor.buildBuilderUpdateSql(entity, setMap, whereConditions, orderBySql, limit);
  }

  /**
   * @internal Used by `UpdateQueryBuilder.execute()` — runs the UPDATE
   * inside the EM transaction wrapper, with tenant scoping and
   * `@UpdateTimestamp` injection applied just like `updateMany`.
   */
  async executeBuilderUpdate<T>(
    entity: ClazzType<T>,
    setEntries: Sql[],
    whereConditions: Sql[],
    orderBySql: Sql | undefined,
    limit: number | undefined,
    setColumns: readonly string[] = [],
  ): Promise<{ affected: number }> {
    return this.finishWrite(entity, this.writeExecutor.executeBuilderUpdate(entity, setEntries, whereConditions, orderBySql, limit, setColumns));
  }

  /**
   * Create an `InsertQueryBuilder` for the given entity (or `qAlias`).
   *
   * The expression-capable counterpart to {@link upsert} / {@link batchUpsert}:
   * those can only overwrite the columns passed with the values proposed
   * (plus the ORM's `@Version` / timestamp / `@DeletedAt` bookkeeping),
   * while the builder's `.doUpdate()` reads the stored row for any column — so an
   * accumulating counter or a high-water mark becomes one statement instead
   * of a locked read-modify-write.
   *
   * @example
   * ```ts
   * await em.createInsertBuilder(SyncMarker)
   *   .values(rows)
   *   .onConflict(["mac", "bucketStart"])
   *   .doUpdate((t, ex) => ({
   *     records:  t.records.add(ex.records),
   *     lastTime: greatest(t.lastTime, ex.lastTime),
   *     syncedAt: sql`NOW()`,
   *   }))
   *   .execute();
   * ```
   */
  createInsertBuilder<T>(entity: ClazzType<T>, alias?: string): InsertQueryBuilder<T>;
  createInsertBuilder<T>(ref: EntityRef<T>): InsertQueryBuilder<T>;
  createInsertBuilder<T>(
    entityOrRef: ClazzType<T> | EntityRef<T>,
    alias?: string,
  ): InsertQueryBuilder<T> {
    const entity: ClazzType<T> = isEntityRef(entityOrRef)
      ? entityOrRef._entity
      : entityOrRef;
    // Before the alias falls back to `entity.name`, so a misused argument is
    // diagnosed instead of dying on `.name` of undefined.
    this.assertEntityInScope(entity, "createInsertBuilder");
    const aliasName: string = isEntityRef(entityOrRef)
      ? entityOrRef._alias
      : (alias ?? entity.name);
    const meta = this.resolver.resolveEntityMetadata(entity);
    if (!meta) {
      throw new EntityMetadataNotFoundError(entity.name);
    }
    const propMap = this.buildPropertyToColumnMap(meta);
    const dialectExpr = createDialectExpression(this._ctx.getDialect());
    return new InsertQueryBuilder<T>(this, entity, aliasName, propMap, dialectExpr);
  }

  /**
   * @internal Used by `InsertQueryBuilder`'s column resolver — the dialect's
   * spelling of a column on the row the INSERT proposed (`EXCLUDED.col`,
   * `excluded.col`, or `VALUES(col)`).
   */
  renderExcludedColumn(wrappedColumn: string): string {
    return this.dmlSqlBuilder.renderExcludedColumn(wrappedColumn);
  }

  /**
   * @internal Used by `InsertQueryBuilder.build()` — builds the INSERT SQL
   * with tenant scoping omitted (build-time only).
   */
  buildBuilderInsertSql<T>(
    entity: ClazzType<T>,
    spec: InsertBuilderSpec<T>,
  ): Sql {
    return this.writeExecutor.buildBuilderInsertSql(entity, spec);
  }

  /**
   * @internal Used by `InsertQueryBuilder.execute()` — runs the INSERT
   * inside the EM transaction wrapper with the tenant column applied.
   */
  async executeBuilderInsert<T>(
    entity: ClazzType<T>,
    spec: InsertBuilderSpec<T>,
  ): Promise<{ affected: number }> {
    return this.finishWrite(entity, this.writeExecutor.executeBuilderInsert(entity, spec));
  }

  async softDelete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    this.assertEntityInScope(entity, "softDelete");
    return this.finishWrite(entity, this.writeExecutor.softDelete(entity, criteria));
  }

  async restore<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    this.assertEntityInScope(entity, "restore");
    return this.finishWrite(entity, this.writeExecutor.restore(entity, criteria));
  }

  // ── Upsert ────────────────────────────────────────────────

  /**
   * Inserts a row, or updates the existing row when it conflicts on the
   * primary key (or `conflictColumns`).
   *
   * Dialect-portable: emits `INSERT … ON DUPLICATE KEY UPDATE` on
   * MySQL/MariaDB and `INSERT … ON CONFLICT … DO UPDATE` on
   * PostgreSQL/SQLite.
   *
   * The ORM-managed columns are filled on a copy of `data` (the object is
   * not modified): client-side UUID keys, `@Version` = 1 and both
   * timestamps on insert. On conflict the primary key and `@CreateTimestamp`
   * are never written, `@Version` becomes the stored value + 1 (not an
   * optimistic-lock check), `@UpdateTimestamp` takes the proposed value and
   * an unstated `@DeletedAt` is reset to NULL, restoring a soft-deleted row.
   * With nothing of the caller's left to update, a live conflicting row is
   * left alone and the INSERT still runs.
   *
   * @returns `{ affected }` — the driver-reported affected-row count.
   *
   * MySQL caveat: for `INSERT … ON DUPLICATE KEY UPDATE`, MySQL reports
   * `affectedRows` as 1 when a new row is inserted and 2 when an existing
   * row is updated; a conflicting row left as it was also reports 1,
   * because `mysql2` connects with `CLIENT_FOUND_ROWS`. This count is
   * returned as-is (not normalized), so callers should not treat it as a
   * literal row count on MySQL. PostgreSQL/SQLite report 1 per row written
   * and 0 for a conflicting row that was skipped.
   */
  async upsert<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    this.assertEntityInScope(entity, "upsert");
    return this.finishWrite(entity, this.writeExecutor.upsert(entity, data, conflictColumns));
  }

  /**
   * Idempotent insert: writes the row if it does not already conflict on
   * the primary key (or `conflictColumns`), and silently skips otherwise.
   *
   * Dialect-portable: emits `INSERT IGNORE` on MySQL/MariaDB and
   * `INSERT … ON CONFLICT DO NOTHING` on PostgreSQL/SQLite. Useful for
   * composite-PK "join" entities (reaction, audit-style rows) where
   * application code wants a "POST is idempotent" semantic without
   * hand-rolling dialect SQL.
   *
   * The inserted row gets the same generated values as {@link upsert}
   * (UUID keys, `@Version`, timestamps), filled on a copy of `data`.
   *
   * @returns `{ affected }` — 1 if a new row was inserted, 0 if a
   * matching row already existed.
   */
  async insertIgnore<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    this.assertEntityInScope(entity, "insertIgnore");
    return this.finishWrite(entity, this.writeExecutor.insertIgnore(entity, data, conflictColumns));
  }

  // ── Batch Upsert ──────────────────────────────────────────

  /**
   * Inserts or updates multiple rows in a single multi-row VALUES statement,
   * conflicting on the primary key (or `conflictColumns`).
   *
   * Dialect-portable: emits `INSERT … ON DUPLICATE KEY UPDATE` on
   * MySQL/MariaDB and `INSERT … ON CONFLICT … DO UPDATE` on
   * PostgreSQL/SQLite.
   *
   * @returns `{ affected }` — the driver-reported affected-row count (0 when
   * `items` is empty). See {@link upsert} for the MySQL `affectedRows`
   * caveat (1 per insert, 2 per update); the count is returned as-is.
   */
  async batchUpsert<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    this.assertEntityInScope(entity, "batchUpsert");
    return this.finishWrite(entity, this.writeExecutor.batchUpsert(entity, items, conflictColumns));
  }

  // ── ManyToMany join-table mutation helpers ─────────────────────────

  /**
   * Insert a row into the M2M join table linking `ownerId` (on `entity`) to
   * `relatedId` (on the related side of `propertyKey`).
   *
   * Dialect-portable: emits `INSERT IGNORE` on MySQL/MariaDB and
   * `INSERT … ON CONFLICT DO NOTHING` on PostgreSQL/SQLite when
   * `ignoreExisting: true` (the default), so re-attaching an existing pair
   * is a zero-row no-op rather than a duplicate-key error.
   *
   * Works for both owning-side relations (declared with `joinTable`) and
   * inverse-side relations (declared with `mappedBy`); the join table is
   * looked up from the owning side either way.
   *
   * @returns `{ affected }` — 1 if a new row was inserted, 0 if the pair
   * already existed (with `ignoreExisting: true`).
   */
  async attachRelation<T>(
    entity: ClazzType<T>,
    ownerId: unknown,
    propertyKey: keyof T & string,
    relatedId: unknown,
    options: { ignoreExisting?: boolean } = {},
  ): Promise<{ affected: number }> {
    this.assertEntityInScope(entity, "attachRelation");
    return this.relationExecutor.attachRelation(
      entity,
      ownerId,
      propertyKey,
      relatedId,
      options,
    );
  }

  /**
   * Delete the row in the M2M join table linking `ownerId` to `relatedId`.
   * Idempotent — deleting a non-existent pair returns `{ affected: 0 }`.
   */
  async detachRelation<T>(
    entity: ClazzType<T>,
    ownerId: unknown,
    propertyKey: keyof T & string,
    relatedId: unknown,
  ): Promise<{ affected: number }> {
    this.assertEntityInScope(entity, "detachRelation");
    return this.relationExecutor.detachRelation(
      entity,
      ownerId,
      propertyKey,
      relatedId,
    );
  }

  // ── Aggregate delegation ─────────────────────────────────────────────

  /**
   * Returns true if at least one entity matches the given where clause.
   *
   * When `onlyDeleted` is true, checks existence among ONLY soft-deleted rows
   * (@DeletedAt IS NOT NULL). It takes precedence over `withDeleted` and is a
   * silent no-op for entities without an @DeletedAt column.
   */
  async exists<T>(
    entity: ClazzType<T>,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<boolean> {
    this.assertEntityInScope(entity, "exists");
    return this.readExecutor.exists(entity, where, withDeleted, onlyDeleted);
  }

  /**
   * Finds a single entity by its primary key value.
   * For composite PKs, pass an object with PK field names as keys.
   */
  async findByPK<T>(
    entity: ClazzType<T>,
    id: unknown,
  ): Promise<T | null> {
    this.assertEntityInScope(entity, "findByPK");
    return this.readExecutor.findByPK(entity, id);
  }

  /**
   * Finds multiple entities by their primary key values.
   * For composite PKs, pass an array of objects with PK field names as keys.
   */
  async findByPKs<T>(
    entity: ClazzType<T>,
    ids: unknown[],
  ): Promise<T[]> {
    this.assertEntityInScope(entity, "findByPKs");
    return this.readExecutor.findByPKs(entity, ids);
  }

  /**
   * Loads multiple entities by primary key and returns them as a `Map` keyed
   * by each entity's primary-key value, for O(1) lookup. This solves the
   * classic batch-load / data-loader problem: `findByPKs()` returns a `T[]`
   * whose order the database does NOT guarantee matches the input `ids`, and
   * offers no way to look an entity up by its key. With the map, callers can
   * reliably reassemble results in input order and detect missing ids via
   * `map.has(id)`.
   *
   * Rows are loaded through {@link findByPKs} (no extra query is issued), so
   * tenant scoping, soft-delete filtering and naming-strategy mapping behave
   * identically.
   *
   * Key strategy:
   * - SINGLE-column PK: the map is keyed by the raw PK value the entity holds
   *   (number / string / bigint) — the same value you would pass to
   *   {@link findByPK}.
   * - COMPOSITE PK: an object cannot be used as a `Map` key (JS Maps compare
   *   objects by reference), so the key is a stable string of the PK columns in
   *   declared order, in the form `"prop1=value1,prop2=value2"`. This mirrors
   *   the Identity Map key format used by `IdentityMapManager.buildIdentityKey`.
   *   Build the same string yourself to look an entry up, or prefer the plain
   *   array returned by {@link findByPKs} when composite keys are unwieldy.
   *
   * Only entities that were actually found appear in the map — missing ids
   * simply have no entry.
   *
   * @example
   * ```ts
   * const ids = [1, 2, 99];
   * const map = await em.findByPKsMap(User, ids);
   * map.has(1);          // true
   * map.get(1);          // User instance
   * map.has(99);         // false — id 99 was not found
   * map.size;            // 2 (number of rows found, not ids requested)
   * // Reassemble in input order, with misses as null:
   * const ordered = ids.map((id) => map.get(id) ?? null);
   *
   * // Composite PK (declared order: tenantId, then userId):
   * const m = await em.findByPKsMap(Membership, [{ tenantId: "acme", userId: 7 }]);
   * m.get("tenantId=acme,userId=7"); // Membership instance
   * ```
   */
  async findByPKsMap<T>(
    entity: ClazzType<T>,
    ids: unknown[],
  ): Promise<Map<string | number | bigint, T>> {
    this.assertEntityInScope(entity, "findByPKsMap");
    return this.readExecutor.findByPKsMap(entity, ids);
  }

  /**
   * Returns the count of entities matching the given conditions.
   *
   * When `onlyDeleted` is true, counts ONLY soft-deleted rows (@DeletedAt
   * IS NOT NULL). It takes precedence over `withDeleted` and is a silent no-op
   * for entities without an @DeletedAt column.
   */
  async count<T>(
    entity: ClazzType<T>,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    this.assertEntityInScope(entity, "count");
    return this.aggregateHandler.count(entity, where, withDeleted, onlyDeleted);
  }

  /**
   * Returns the sum of a numeric field for entities matching the given
   * conditions.
   *
   * When `onlyDeleted` is true, sums over ONLY soft-deleted rows (@DeletedAt
   * IS NOT NULL). It takes precedence over `withDeleted` and is a silent no-op
   * for entities without an @DeletedAt column.
   */
  async sum<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    this.assertEntityInScope(entity, "sum");
    return this.aggregateHandler.sum(
      entity,
      field,
      where,
      withDeleted,
      onlyDeleted,
    );
  }

  /**
   * Returns the average of a numeric field for entities matching the given
   * conditions.
   *
   * When `onlyDeleted` is true, averages over ONLY soft-deleted rows (@DeletedAt
   * IS NOT NULL). It takes precedence over `withDeleted` and is a silent no-op
   * for entities without an @DeletedAt column.
   */
  async avg<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    this.assertEntityInScope(entity, "avg");
    return this.aggregateHandler.avg(
      entity,
      field,
      where,
      withDeleted,
      onlyDeleted,
    );
  }

  /**
   * Returns the minimum value of a field for entities matching the given
   * conditions.
   *
   * When `onlyDeleted` is true, takes the minimum over ONLY soft-deleted rows
   * (@DeletedAt IS NOT NULL). It takes precedence over `withDeleted` and is a
   * silent no-op for entities without an @DeletedAt column.
   */
  async min<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    this.assertEntityInScope(entity, "min");
    return this.aggregateHandler.min(
      entity,
      field,
      where,
      withDeleted,
      onlyDeleted,
    );
  }

  /**
   * Returns the maximum value of a field for entities matching the given
   * conditions.
   *
   * When `onlyDeleted` is true, takes the maximum over ONLY soft-deleted rows
   * (@DeletedAt IS NOT NULL). It takes precedence over `withDeleted` and is a
   * silent no-op for entities without an @DeletedAt column.
   */
  async max<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    this.assertEntityInScope(entity, "max");
    return this.aggregateHandler.max(
      entity,
      field,
      where,
      withDeleted,
      onlyDeleted,
    );
  }

  // ── EXPLAIN delegation ──────────────────────────────────────

  async explain<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<ExplainResult> {
    this.assertEntityInScope(entity, "explain");
    return this.explainHandler.explain(entity, findOption);
  }

  // ── Utilities ──────────────────────────────────────────────

  /**
   * Fail-fast column check for the criteria of a bulk write (delete /
   * updateMany / softDelete / restore).
   *
   * Walks the criteria with the same validator the read paths use, so
   * `AND` / `OR` / `NOT` (nested included) are traversed rather than mistaken
   * for column names — the resolver has always accepted them, only this guard
   * rejected them. The accepted set is derived from the SAME source the SQL
   * builder uses (buildPropertyToColumnMap), so the guard accepts every key
   * the builder can resolve and the two can never drift: @Column property and
   * DB names, @ManyToOne/@OneToOne FK shadow properties (`userId` → `user_id`,
   * #353) and @ComputedColumn names, which are filterable but absent from
   * `metadata.columns`.
   */
  private validateCriteriaKeys<T>(
    metadata: { target?: ClazzType<any>; columns: ColumnMetadata[] },
    criteria: WhereClause<T>,
    entityName: string,
    clause: "criteria" | "where" = "criteria",
  ): void {
    const scope = buildColumnNameScope({
      entityName,
      columns: metadata.columns,
      propertyToColumn: this.buildPropertyToColumnMap(metadata),
      computedColumns: metadata.target
        ? this.getComputedColumnNames(metadata.target)
        : null,
    });
    validateWhereIdentifiers(criteria, scope, clause);
  }

  /**
   * Fail-fast column check for the SET payload of updateMany. Flat by
   * design: a combinator key is a misplaced filter, not a column, and a
   * @ComputedColumn cannot be assigned, so neither is in scope here.
   */
  private validateUpdateDataKeys<T>(
    metadata: { target?: ClazzType<any>; columns: ColumnMetadata[] },
    data: UpdateData<T>,
    entityName: string,
  ): void {
    const scope = buildColumnNameScope({
      entityName,
      columns: metadata.columns,
      propertyToColumn: this.buildPropertyToColumnMap(metadata),
    });
    validateUpdateDataIdentifiers(data, scope);
  }

  /**
   * The keys a write payload may carry for an entity: everything the INSERT /
   * UPDATE builders read, plus what an entity instance legitimately holds.
   *
   * Narrower than the read scope on purpose — the write paths address values
   * by property key only, so a DB column name typed instead of the property
   * (`team_name` for `teamName`) is *not* written and must be reported, where
   * a read `where` would have resolved it. Accepted:
   *
   * - `@Column` property keys (the tenant column is one of them once
   *   injected) — not their DB names;
   * - `@ManyToOne` / `@OneToOne` FK shadow properties (`teamId`, `fkProperty`)
   *   and the join column names themselves — the cascade handler writes the
   *   raw join column onto a child before saving it;
   * - relation properties of all four kinds (cascade input, hydrated
   *   instances);
   * - `@ComputedColumn` properties — never written, but present on every
   *   instance read back;
   * - in a single-table hierarchy, the discriminator column and the columns
   *   of the sibling classes sharing the table, as on the read side.
   */
  private buildWriteInputScope<T>(
    entity: ClazzType<T>,
    metadata: { target?: ClazzType<any>; columns: ColumnMetadata[] },
  ): ColumnNameScope {
    const valid = new Set<string>();

    for (const col of metadata.columns) valid.add(this.propKey(col));

    // The resolver may be a partial mock in unit tests, so each relation
    // lookup is guarded the same way buildPropertyToColumnMap guards its own.
    const resolver = this.resolver as Partial<RelationMetadataResolver>;
    if (typeof resolver.collectFkPropertyMappings === "function") {
      for (const [prop, joinColumn] of resolver.collectFkPropertyMappings(entity)) {
        valid.add(prop);
        valid.add(joinColumn);
      }
    }
    if (typeof resolver.resolveManyToOneMetadata === "function") {
      for (const rel of resolver.resolveManyToOneMetadata(entity)) {
        valid.add(rel.columnName);
        if (rel.joinColumn) valid.add(rel.joinColumn);
      }
    }
    if (typeof resolver.resolveOneToOneMetadata === "function") {
      for (const rel of resolver.resolveOneToOneMetadata(entity)) {
        valid.add(rel.propertyKey);
        if (rel.joinColumn) valid.add(rel.joinColumn);
      }
    }
    if (typeof resolver.resolveOneToManyMetadata === "function") {
      for (const rel of resolver.resolveOneToManyMetadata(entity)) {
        valid.add(rel.propertyKey);
      }
    }
    if (typeof resolver.resolveManyToManyMetadata === "function") {
      for (const rel of resolver.resolveManyToManyMetadata(entity)) {
        valid.add(rel.propertyKey);
      }
    }

    const computed: ComputedColumnMetadata[] =
      Reflect.getMetadata(COMPUTED_COLUMN_TOKEN, entity?.prototype) ?? [];
    for (const col of computed) {
      valid.add(col.propertyKey);
      valid.add(col.name);
    }

    if (this.inheritanceResolver.getStrategy(entity) !== null) {
      const root = this.inheritanceResolver.getRoot(entity) ?? entity;
      for (const col of this.inheritanceResolver.getAllHierarchyColumns(root)) {
        valid.add(this.propKey(col));
      }
      const disc = this.inheritanceResolver.getDiscriminatorColumn(root);
      if (disc) valid.add(disc.name);
    }

    return { entityName: entity.name, valid };
  }

  /**
   * Applies the `unknownWriteKeys` policy to the payload(s) of a write.
   *
   * Runs before hooks, cascades and tenant injection so it sees exactly what
   * the caller passed. `"throw"` raises the read-path `InvalidQueryError`
   * (clause `"data"`) for the first unknown key; `"warn"` logs each distinct
   * key once per entity for the lifetime of this EntityManager, naming the
   * calling method and the closest accepted key.
   */
  private validateWriteInputKeys<T>(
    entity: ClazzType<T>,
    metadata: { target?: ClazzType<any>; columns: ColumnMetadata[] },
    items: readonly unknown[],
    method: string,
  ): void {
    const policy = this.unknownWriteKeyPolicy;
    if (policy === "ignore") return;

    const scope = this.buildWriteInputScope(entity, metadata);

    for (const item of items) {
      for (const key of collectUnknownWriteKeys(item, scope)) {
        if (policy === "throw") {
          assertKnownColumn(key, "data", scope);
        }

        const dedupKey = `${entity.name}.${key}`;
        if (this.writeKeyWarned.has(dedupKey)) continue;
        this.writeKeyWarned.add(dedupKey);

        const suggestion = closestIdentifier(key, scope.valid);
        this.logger.warn(
          `[WriteInput] Unknown key "${key}" in the data passed to ${method}() for entity "${entity.name}" ` +
            `— it matches no column, relation or FK property and was not written.` +
            (suggestion ? ` Did you mean "${suggestion}"?` : "") +
            ` Set unknownWriteKeys: "throw" to reject such writes, or "ignore" to silence this warning.`,
        );
      }
    }
  }

  /**
   * Returns the TypeScript property key for a column metadata entry.
   * Use this when accessing entity object properties (not for SQL generation).
   */
  private propKey(col: { propertyKey?: string; name: string }): string {
    return col.propertyKey ?? col.name;
  }

  /**
   * Applies the column's write transformer (to) to the raw value.
   *
   * Precedence: explicit `column.transformer.to` → ColumnTypeRegistry → default
   * JSON round-trip for `type: "json" | "jsonb"`. The JSON default lets users
   * assign plain JS values without the `JSON.stringify(...) as any` boilerplate;
   * mysql2 rejects native objects on JSON columns, so the stringify step is
   * mandatory for that driver. PostgreSQL accepts both strings and objects on
   * jsonb, so the same path is safe there. `type: "array"` takes the same JSON
   * round-trip outside PostgreSQL, whose driver binds a native array itself.
   *
   * The result is then checked by {@link assertColumnBindValue}: an array or
   * object left for a column that cannot store it throws instead of being
   * spread over the bind parameters.
   *
   * A raw `sql` fragment and a compiled-query placeholder skip the whole step.
   * Neither is a value: the fragment is spliced into the statement as written
   * and the placeholder is substituted at execute time, so transforming them
   * would serialize the marker object itself — a `json` column would store
   * `{"strings":["NOW()"],"values":[]}`.
   *
   * @param site - The operation to name if the value is rejected ("save()").
   */
  private applyWriteTransform(
    col: ColumnMetadata,
    rawValue: any,
    site?: string,
  ): any {
    if (isSqlFragment(rawValue) || isPlaceholder(rawValue)) return rawValue;
    const value = this.transformWriteValue(col, rawValue);
    if (value !== null && typeof value === "object") {
      assertColumnBindValue(col, value, () => this._ctx.getDialect(), site);
    }
    return value;
  }

  private transformWriteValue(col: ColumnMetadata, rawValue: any): any {
    if (col.transformer?.to) return col.transformer.to(rawValue);
    const type = col.options?.type;
    if (type) {
      const regTo = ColumnTypeRegistry.getInstance().getTransformer(type)?.to;
      if (regTo) return regTo(rawValue);
      if (isJsonColumnType(type)) {
        return defaultJsonColumnWrite(rawValue);
      }
      if (type === "array" && !this.isPostgres()) {
        return defaultJsonColumnWrite(rawValue);
      }
    }
    return rawValue;
  }

  /**
   * Builds a Map from TypeScript property names to DB column names
   * for NamingStrategy-aware WHERE/SELECT/ORDER resolution.
   *
   * `@Column` properties are read from `metadata.columns`.
   * `@ManyToOne` / `@OneToOne` FK backing properties (e.g. `workspaceId`
   * for a `workspace!: Workspace` relation) are folded in via
   * `resolver.collectFkPropertyMappings()` so that `qAlias(Entity).fkProp`
   * resolves to the snake_case FK column. Without this, FK access
   * through qAlias rendered the camelCase property name verbatim and the
   * database rejected it.
   */
  private buildPropertyToColumnMap(metadata: {
    target?: ClazzType<any>;
    columns: ColumnMetadata[];
  }): Map<string, string> {
    // The map is rebuilt on every read query (findInternal / findWithCursor /
    // aggregate / explain / query builder), but its inputs — entity columns and
    // FK relation metadata — only change when a metadata layer is mutated.
    // `resolveAll()` returns the current context's merged view and mints a new
    // Map identity on any layer change (markDirty), so keying the cache on
    // that identity makes it both tenant-context-aware (each tenant's merged
    // view is a distinct key, so a tenant layer overriding columns or
    // relations never shares entries with public) and self-invalidating.
    // Consumers only read the returned map, so a shared instance is safe.
    const cacheable =
      metadata.target !== undefined &&
      typeof this.resolver?.collectFkPropertyMappings === "function";
    let byMetadata: WeakMap<object, Map<string, string>> | undefined;
    if (cacheable) {
      const mergedView = MetadataLayerRegistry.getInstance().resolveAll();
      byMetadata = this.propToColCache.get(mergedView);
      if (!byMetadata) {
        byMetadata = new WeakMap();
        this.propToColCache.set(mergedView, byMetadata);
      }
      const cached = byMetadata.get(metadata);
      if (cached) return cached;
    }

    const map = buildSharedPropertyToColumnMap(metadata, this.resolver);
    attachWhereValueTransform(map, metadata.columns);
    if (byMetadata) byMetadata.set(metadata, map);
    return map;
  }

  wrap(columnName: string) {
    if (this.driver && "wrap" in this.driver) {
      return (this.driver as any).wrap(columnName);
    }
    if (this.isPostgres()) {
      return `"${columnName.replace(/"/g, '""')}"`;
    }
    return `\`${columnName.replace(/`/g, "``")}\``;
  }

  /**
   * Typed entity reference for use inside `sql\`\`` templates. Replaces
   * hand-rolled `wrap()` + `raw()` boilerplate inside raw queries.
   *
   * **No alias** (`em.ref(Issue)`):
   * - `${ref}` → `"issue"` — drop into FROM, INSERT, UPDATE
   * - `${ref.id}` → `"id"` — bare wrapped column
   *
   * **With alias** (`em.ref(Issue, "i")`):
   * - `${ref}` → `"issue" AS i` — declares table+alias in one shot
   * - `${ref.id}` → `i."id"` — alias-qualified column
   *
   * `.as(prop, asName?)` emits `"col" AS "asName"` (or alias-qualified
   * variant). Multiple refs with different aliases compose for self-joins.
   */
  ref<T>(entity: ClazzType<T>, alias?: string): SqlRef<T> {
    this.assertEntityArgument(entity, "ref");
    return createEntitySqlRef<T>(
      entity,
      {
        wrap: (n) => this.wrap(n),
        wrapTable: (n) => this.wrapTable(n),
        collectFkPropertyMappings:
          typeof this.resolver?.collectFkPropertyMappings === "function"
            ? (e) => this.resolver.collectFkPropertyMappings(e)
            : undefined,
      },
      alias,
    );
  }

  /**
   * Alias-only sibling of `ref()` for CTE / derived-table column refs that
   * have no entity to bind. `${aliasRef}` → bare alias name; `${aliasRef.col}`
   * → `alias."col"` with `camelToSnakeCase` applied to the property name.
   *
   * Use for recursive-CTE-only columns like `depth` / `path` that are
   * synthesized inside the CTE body. For entity tables, prefer
   * `em.ref(Entity, alias)`.
   */
  aliasRef(alias: string): AliasRef {
    return createAliasRef(alias, (n) => this.wrap(n));
  }

  /**
   * Bulk variant of `ref()` / `aliasRef()` that returns a typed tuple.
   * Lets multi-ref CTE / self-join blocks declare every reference on one
   * line instead of N separate statements.
   *
   * Each spec resolves as:
   * - `Entity`              → `em.ref(Entity)`            → `SqlRef<Entity>`
   * - `[Entity, "alias"]`   → `em.ref(Entity, "alias")`   → `SqlRef<Entity>`
   * - `"alias"`             → `em.aliasRef("alias")`      → `AliasRef`
   *
   * @example
   * ```ts
   * const [I, Ic, p] = em.refs(Issue, [Issue, "c"], "p");
   * // equivalent to:
   * //   const I  = em.ref(Issue);
   * //   const Ic = em.ref(Issue, "c");
   * //   const p  = em.aliasRef("p");
   * ```
   */
  refs<const T extends readonly RefSpec[]>(...specs: T): RefTuple<T> {
    return specs.map((spec) => {
      if (typeof spec === "string") {
        return this.aliasRef(spec);
      }
      if (Array.isArray(spec)) {
        return this.ref(
          spec[0] as ClazzType<unknown>,
          spec[1] as string,
        );
      }
      return this.ref(spec as ClazzType<unknown>);
    }) as RefTuple<T>;
  }

  /**
   * Wrap a table name with optional schema qualification for multi-tenant queries.
   * Uses the configured TenantQueryStrategy to determine whether to prefix with tenant schema.
   */
  wrapTable(tableName: string): string {
    return this.tenantScope.wrapTable(tableName);
  }

  /**
   * Returns tenant-column strategy configuration when active, otherwise null.
   * Used by DDL generators, query builders, and insert/update code paths.
   */
  public getTenantColumnConfig(): {
    name: string;
    type: "varchar" | "uuid" | "int" | "bigint";
    length?: number;
  } | null {
    return this.tenantScope.columnConfig;
  }

  /**
   * Returns the active TenantQueryStrategy — exposed for advanced use cases
   * (custom query builders, testing, observability).
   */
  public getTenantStrategy(): TenantQueryStrategy {
    return this.tenantScope.strategy;
  }

  /**
   * Returns the PostgreSQL schema an entity's table is pinned to —
   * `@Entity({ schema })` / the code-first `schema` option, or
   * `@NonTenantEntity()` under `search_path` / `schema_qualified` (which
   * resolves to the connection's default schema). `undefined` means the table
   * follows the default schema and the active tenant strategy. Always
   * `undefined` on MySQL and SQLite.
   */
  public resolveEntitySchema<T>(entity: ClazzType<T>): string | undefined {
    return this.tenantScope.resolveEntitySchema(entity);
  }

  /**
   * Engine delegator — implementation lives in {@link TenantScopeManager}.
   * Kept on the facade so `_ctx` routing and internal callers stay interceptable.
   */
  private buildTenantWhereClause<T>(
    entity: ClazzType<T>,
    tableAliasOrName?: string,
    tenantTable?: "auto" | "root",
  ): Sql | null {
    return this.tenantScope.buildTenantWhereClause(
      entity,
      tableAliasOrName,
      tenantTable,
    );
  }

  /** Engine delegator — implementation lives in {@link TenantScopeManager}. */
  private applyTenantColumnOnInsert<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): void {
    this.tenantScope.applyTenantColumnOnInsert(entity, item);
  }

  /** Engine delegator — implementation lives in {@link TenantScopeManager}. */
  private assertTenantColumnOnUpdate<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): void {
    this.tenantScope.assertTenantColumnOnUpdate(entity, item);
  }

  /**
   * The tenant discriminator column for an entity, or null when the entity is
   * not tenant-scoped. Engine delegator — {@link TenantScopeManager} resolves
   * the name through the naming strategy.
   */
  private resolveTenantColumnName<T>(entity: ClazzType<T>): string | null {
    return this.tenantScope.isTenantScopedEntity(entity)
      ? this.tenantScope.resolveTenantColumnName(entity)
      : null;
  }

  private getComputedColumnNames<T>(entity: ClazzType<T>): Set<string> {
    const meta: ComputedColumnMetadata[] =
      Reflect.getMetadata(COMPUTED_COLUMN_TOKEN, entity?.prototype) ?? [];
    return new Set(meta.map((m) => m.name));
  }

  private isMySqlFamily() {
    const t = this.dbType ?? (this.client as any).type;
    return ["mysql", "mariadb"].includes(t as IDatabaseType);
  }

  private isPostgres() {
    const t = this.dbType ?? (this.client as any).type;
    return t === "postgres";
  }

  private isSqlite() {
    const t = this.dbType ?? (this.client as any).type;
    return t === "sqlite";
  }

  /** Dialect-specific row-lock suffix (FOR UPDATE / FOR SHARE / NOWAIT / SKIP LOCKED). */
  private resolveLockSuffix(lock: LockMode): string {
    const isMySql = this.isMySqlFamily();
    const isSqlite = this.isSqlite();

    switch (lock) {
      case LockMode.PESSIMISTIC_WRITE:
        return "FOR UPDATE";
      case LockMode.PESSIMISTIC_READ:
        return isMySql ? "LOCK IN SHARE MODE" : "FOR SHARE";
      case LockMode.PESSIMISTIC_WRITE_NOWAIT:
        if (isSqlite) throw new OrmError(OrmErrorCode.UNSUPPORTED_DATABASE, "SQLite does not support NOWAIT");
        return "FOR UPDATE NOWAIT";
      case LockMode.PESSIMISTIC_READ_NOWAIT:
        if (isSqlite) throw new OrmError(OrmErrorCode.UNSUPPORTED_DATABASE, "SQLite does not support NOWAIT");
        return isMySql ? "LOCK IN SHARE MODE NOWAIT" : "FOR SHARE NOWAIT";
      case LockMode.PESSIMISTIC_WRITE_SKIP_LOCKED:
        if (isSqlite) throw new OrmError(OrmErrorCode.UNSUPPORTED_DATABASE, "SQLite does not support SKIP LOCKED");
        return "FOR UPDATE SKIP LOCKED";
      case LockMode.PESSIMISTIC_READ_SKIP_LOCKED:
        if (isSqlite) throw new OrmError(OrmErrorCode.UNSUPPORTED_DATABASE, "SQLite does not support SKIP LOCKED");
        return isMySql ? "LOCK IN SHARE MODE SKIP LOCKED" : "FOR SHARE SKIP LOCKED";
      default:
        return "FOR UPDATE";
    }
  }

  private hasEagerRelations<T>(entity: ClazzType<T>): boolean {
    const m2o = this.resolver.resolveManyToOneMetadata(entity);
    if (m2o.some((rel) => rel.option?.eager === true)) return true;
    const o2o = this.resolver.resolveOneToOneMetadata(entity);
    if (o2o.some((rel) => rel.joinColumn && rel.option?.eager === true)) return true;
    return false;
  }

  /**
   * In cursor pagination, when the PK is non-numeric (varchar, char, text, etc.),
   * emits a single dialect-specific warning.
   */
  private warnIfNonSortablePk(entityName: string, pk: ColumnMetadata): void {
    const pkType = pk.options?.type as string | undefined;
    const numericTypes = new Set([
      "int", "number", "float", "double", "bigint",
    ]);
    if (!pkType || numericTypes.has(pkType)) {
      return;
    }

    const key = entityName;
    if (this.cursorPkWarned.has(key)) {
      return;
    }
    this.cursorPkWarned.add(key);

    const base =
      `[CursorPagination] '${entityName}' entity uses a non-numeric PK ` +
      `(type: ${pkType}). Cursor pagination defaults to PK ordering, ` +
      `which may not reflect insertion order for random values like UUID v4.`;

    if (this.isMySqlFamily()) {
      this.logger.warn(
        `${base} MySQL stores UUIDs as VARCHAR — lexicographic ordering ` +
        `does not match time-based ordering. Consider specifying ` +
        `orderBy: "createdAt" or using a sequential ID.`,
      );
    } else if (this.isPostgres()) {
      this.logger.warn(
        `${base} PostgreSQL compares UUID values lexicographically. ` +
        `For time-ordered pagination, use UUID v7 (sortable) or specify ` +
        `orderBy: "createdAt".`,
      );
    } else if (this.isSqlite()) {
      this.logger.warn(
        `${base} SQLite compares TEXT values lexicographically. ` +
        `Consider specifying orderBy: "createdAt" or using an INTEGER PK.`,
      );
    } else {
      this.logger.warn(
        `${base} Consider specifying an explicit orderBy column ` +
        `(e.g. orderBy: "createdAt") for meaningful pagination order.`,
      );
    }
  }

  /**
   * Engine delegator — implementation lives in {@link TransactionRunner}.
   * Kept on the facade so `_ctx` / `PluginContext` routing and test spies
   * keep intercepting on the EntityManager.
   */
  private async executeInTransaction<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    existingSession?: TransactionSessionManager,
    readNodeOverride?: ReplicationNodeConfig | null,
    txOptions?: ExecuteTransactionOptions,
  ): Promise<R> {
    return this.transactionRunner.executeInTransaction(
      fn,
      existingSession,
      readNodeOverride,
      txOptions,
    );
  }

  /** Engine delegator — implementation lives in {@link TransactionRunner}. */
  private async executeReadOnly<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    options?: {
      existingSession?: TransactionSessionManager;
      readNodeOverride?: ReplicationNodeConfig | null;
      timeout?: number;
    },
  ): Promise<R> {
    return this.transactionRunner.executeReadOnly(fn, options);
  }

  private resolveSelectColumns<T>(select: ISelectOption<T>): string[] {
    if (Array.isArray(select)) {
      return select.map((col) => String(col));
    }

    const columns: string[] = [];
    for (const key in select) {
      if ((select as any)[key] === true) {
        columns.push(key);
      }
    }
    return columns;
  }

  // ── Miscellaneous ──────────────────────────────────────────────

  /**
   * Tagged-template form. `${...}` interpolations resolve as:
   * - Entity class (`Issue`)        → `em.ref(Issue)` — table identifier
   *   with the active tenant schema qualifier and snake_case mapping
   * - `SqlRef` / `AliasRef` / `Sql` → fragment, inlined as-is
   * - everything else               → bound as a prepared-statement parameter
   *
   * @example
   * ```ts
   * await em.query<Issue>`
   *   SELECT * FROM ${Issue} WHERE id = ${id}
   * `;
   * ```
   *
   * **Trade-off:** column names inside the template (e.g. `id` above) are
   * plain text. Typos surface at runtime as SQL errors — they are not
   * caught by the compiler. When column-level safety matters, drop down
   * to `em.ref(Entity).column` (which is type-checked against the
   * entity's properties).
   */
  async query<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  /** Pre-built `Sql` fragment or raw string with optional positional binds. */
  async query<T = Record<string, unknown>>(
    sqlQuery: string | Sql,
    params?: unknown[],
  ): Promise<T[]>;
  async query<T = Record<string, unknown>>(
    sqlOrStrings: string | Sql | TemplateStringsArray,
    ...rest: unknown[]
  ): Promise<T[]> {
    return this.rawQueryRunner.query<T>(sqlOrStrings, rest);
  }

  /**
   * Executes a callback within a database transaction.
   * Auto-commits on success, auto-rollbacks on error.
   *
   * All EntityManager operations inside the callback share the same transaction.
   *
   * This is the programmatic, decorator-free counterpart to `@Transactional`.
   * It accepts the same `isolationLevel`, `propagation`, and `connectionName`
   * options the decorator does, plus optional deadlock retry.
   *
   * @param callback A function that receives this EntityManager and performs DB operations.
   * @param options Isolation level, propagation, connection, and retry behavior.
   * @returns The return value of the callback.
   *
   * @example
   * ```ts
   * const result = await em.transaction(async (txEm) => {
   *   await txEm.save(User, { name: "Alice" });
   *   await txEm.save(Post, { title: "Hello", authorId: 1 });
   *   return "done";
   * }, { isolationLevel: "SERIALIZABLE", propagation: TransactionPropagation.REQUIRES_NEW });
   * ```
   */
  async transaction<R>(
    callback: (em: this) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R> {
    return this.transactionRunner.transaction(
      callback as (em: EntityManager) => Promise<R>,
      options,
    );
  }

  getRepository<T>(entity: ClazzType<T>) {
    this.assertEntityInScope(entity, "getRepository");
    return BaseRepository.of(entity, this);
  }

  async withTenant<R>(
    tenantId: string,
    callback: (em: this) => Promise<R>,
  ): Promise<R> {
    return MetadataContext.run(tenantId, () => callback(this)) as Promise<R>;
  }

  createQueryBuilder(): BaseRawQueryBuilder;
  createQueryBuilder<T>(entity: ClazzType<T>, alias: string): SelectQueryBuilder<T, T>;
  createQueryBuilder<T>(ref: EntityRef<T>): SelectQueryBuilder<T, T>;
  createQueryBuilder<T>(entityOrRef?: ClazzType<T> | EntityRef<T>, alias?: string): BaseRawQueryBuilder | SelectQueryBuilder<T, T> {
    let entity: ClazzType<T> | undefined;
    let resolvedAlias: string | undefined;
    if (isEntityRef(entityOrRef)) {
      entity = entityOrRef._entity;
      resolvedAlias = entityOrRef._alias;
    } else {
      entity = entityOrRef;
      resolvedAlias = alias;
    }
    if (entity && resolvedAlias) {
      this.assertEntityInScope(entity, "createQueryBuilder");
      const qb = new SelectQueryBuilder<T>(entity, resolvedAlias, this);
      qb.setDialectExpression(createDialectExpression(this._ctx.getDialect()));
      const meta = this.resolver.resolveEntityMetadata(entity);
      if (meta) {
        qb.setPropertyToColumnMap(this.buildPropertyToColumnMap(meta));
      }
      // Inheritance-aware setup
      const strategy = this.inheritanceResolver.getStrategy(entity);
      if (strategy) {
        qb.applyInheritance(this.inheritanceResolver, this.resolver);
      }
      return qb;
    }
    const qb = RawQueryBuilderFactory.create();
    if (this.isMySqlFamily()) qb.setDatabaseType("mysql");
    else if (this.isSqlite()) qb.setDatabaseType("sqlite");
    else qb.setDatabaseType("postgresql");
    return qb;
  }

  /**
   * Compile a query once for repeated execution with different parameters.
   *
   * The callback receives this `EntityManager` and a proxy that yields
   * a fresh `PlaceholderMarker` for every property access. Use those
   * markers wherever a value is expected — WHERE bindings, LIMIT, etc.
   * The callback must return a builder exposing `.prepare()`.
   *
   * @example
   * ```ts
   * const getUser = em.compile<User, { id: number }>((em, $) =>
   *   em.createQueryBuilder(User, "u").where(sql`u.id = ${$.id}`)
   * );
   *
   * await getUser.executeOne({ id: 42 });
   * await getUser.executeOne({ id: 77 });   // SQL not rebuilt
   * ```
   */
  compile<T, P extends Record<string, unknown>>(
    fn: (em: this, params: { [K in keyof P]: PlaceholderMarker }) =>
      | SelectQueryBuilder<T, any>
      | { prepare: () => CompiledQuery<T, P> }
      | { prepare: (executor: any) => CompiledQuery<T, P> },
  ): CompiledQuery<T, P> {
    const proxy = new Proxy({} as any, {
      get: (_target, key: string | symbol) => {
        if (typeof key === "symbol") return undefined;
        return createPlaceholder(key);
      },
    });
    const builder = fn(this, proxy);
    const prep = (builder as any).prepare;
    if (typeof prep !== "function") {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "em.compile() callback must return a builder exposing .prepare().",
      );
    }
    // SelectQueryBuilder.prepare() is zero-arg; RawQueryBuilder.prepare(em)
    // needs the executor. Call length disambiguates them.
    const result =
      prep.length >= 1 ? prep.call(builder, this) : prep.call(builder);
    return result as CompiledQuery<T, P>;
  }

  getDriver(): ISqlDriver | undefined {
    return this.driver;
  }

  /** Engine delegator — implementation lives in {@link TenantScopeManager}. */
  private warnIfRawQueryBypassesTenant(): void {
    this.tenantScope.warnIfRawQueryBypassesTenant();
  }

  /**
   * Checks if a tenant context (MetadataContext.run) is active.
   * Logs a warning if not — useful in middleware/guards to catch missing context early.
   * @returns true if tenant context is active, false if falling back to "public"
   */
  assertTenantContext(): boolean {
    return this.tenantScope.assertTenantContext();
  }

  // ── Public Metadata API (#233) ─────────────────────────────

  /**
   * Returns all entity classes registered on this EntityManager.
   */
  getRegisteredEntities(): ClazzType<any>[] {
    return [...this._entities];
  }

  /**
   * Returns structured metadata for the given entity class:
   * table name, columns, relations, indexes, timestamps, etc.
   */
  getEntityMetadata<T>(entity: ClazzType<T>): EntityMetadataView | null {
    return this.metadataViewFactory.getEntityMetadata(entity);
  }

  /**
   * Returns column metadata for the given entity class.
   */
  getColumnMetadata<T>(entity: ClazzType<T>): ColumnMetadataView[] {
    return this.metadataViewFactory.getColumnMetadata(entity);
  }

  /**
   * Returns relation metadata for the given entity class.
   */
  getRelationMetadata<T>(entity: ClazzType<T>): RelationMetadataView[] {
    return this.metadataViewFactory.getRelationMetadata(entity);
  }
}


