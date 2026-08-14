/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { ClazzType, Logger, resolveEntityGlobs, generateUUIDv7 } from "../utils";
import { DeserializerRegistry } from "./deserializer/DeserializerRegistry";
import { ColumnMetadata, MetadataLayerRegistry } from "../scanner";
import { DatabaseClient } from "../DatabaseClient";
import { ISqlDriver } from "../dialects/SqlDriver";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { FindOption, LockMode, UpdateData, UpdateManyOptions, WhereClause } from "../dialects/FindOption";
import { resolveWhereClause } from "./WhereResolver";
import { ISelectOption } from "../dialects/ISelectOption";
import { IDataSource } from "../dialects/IDataSource";
import { Sql } from "../utils/sqlTag";
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
  validateDatabaseClientOptions,
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
import { OptimisticLockError } from "../errors/OptimisticLockError";
import { PrimaryKeyNotFoundError } from "../errors/PrimaryKeyNotFoundError";
import { DeleteWithoutConditionsError } from "../errors/DeleteWithoutConditionsError";
import { EntityNotFoundError } from "../errors/EntityNotFoundError";
import { NotSupportedDatabaseTypeError } from "../errors/NotSupportedDatabaseTypeError";
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
import { LoggingOptions } from "./DatabaseClientOptions";
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
import { DefaultNamingStrategy, NamingStrategy } from "./generators/NamingStrategy";
import { ENTITY_TOKEN, EntityMetadata } from "../decorators/Entity";
import { COLUMN_TOKEN } from "../decorators/Column";
import { createAliasRef, createEntitySqlRef, AliasRef, SqlRef } from "./SqlRef";
import { InheritanceResolver } from "./InheritanceResolver";
import { CREATE_TIMESTAMP_TOKEN } from "../decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../decorators/UpdateTimestamp";
import { DELETED_AT_TOKEN } from "../decorators/DeletedAt";
import { VERSION_TOKEN } from "../decorators/Version";
import type { WriteBuffer } from "./plugin/buffer/WriteBuffer";
import type { BufferPluginOptions } from "./plugin/buffer/BufferPreview";
import type { RawPipeline, RawPipelineOptions } from "./plugin/raw-pipeline/RawPipeline";
import { createDialectExpression } from "../dialects/DialectExpression";
import { SelectQueryBuilder, isEntityRef } from "./SelectQueryBuilder";
import type { EntityRef } from "./SelectQueryBuilder";
import { UpdateQueryBuilder } from "./UpdateQueryBuilder";
import { CompiledQuery, p as createPlaceholder, PlaceholderMarker } from "./CompiledQuery";
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
    saveWithSession: (e, i, s) => this.writeExecutor.saveInternal(e, i, s),
    find: (e, o) => this.find(e, o),
    findOne: (e, o) => this.findOne(e, o),
    findAndCount: (e, o) => this.findAndCount(e, o),
    delete: (e, c) => this.delete(e, c),
    getTenantColumnConfig: () => this.tenantColumnConfig,
    buildTenantWhereClause: (e, alias) => this.buildTenantWhereClause(e, alias),
    buildPropertyToColumnMap: (m) => this.buildPropertyToColumnMap(m),
    propKey: (col) => this.propKey(col),
    applyWriteTransform: (col, v) => this.applyWriteTransform(col, v),
    applyTenantColumnOnInsert: (e, i) => this.applyTenantColumnOnInsert(e, i),
    getComputedColumnNames: (e) => this.getComputedColumnNames(e),
    validateCriteriaKeys: (m, c, n) => this.validateCriteriaKeys(m, c, n),
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
    validateDatabaseClientOptions(databaseClientOptions);

    // ESM builds cannot probe class-transformer synchronously (no require);
    // finish the async auto-detection before any query can deserialize rows.
    await DeserializerRegistry.ensureDefaultDetected();

    if (databaseClientOptions.namingStrategy) {
      this.schemaRegistrar = new SchemaRegistrar(
        this.resolver,
        this._ctx,
        databaseClientOptions.namingStrategy,
      );
    }
    await this.connect(databaseClientOptions, connectionName);
    this.applyNamingStrategy(databaseClientOptions.namingStrategy);
    await this.schemaRegistrar.registerEntities();

    // Install plugins (in array order)
    if (databaseClientOptions.plugins) {
      for (const plugin of databaseClientOptions.plugins) {
        this.extend(plugin);
      }
    }
  }

  private applyNamingStrategy(strategy?: NamingStrategy): void {
    EntityManager.applyNamingStrategyToEntities(this._entities, strategy);
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
    const ns = strategy ?? new DefaultNamingStrategy();

    for (const entity of entities) {
      const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as EntityMetadata | undefined;
      if (!meta) continue;

      // 1. Table name (skip STI children — they share the root's table name)
      if (!meta.nameExplicit && !meta.inheritanceRoot) {
        meta.name = ns.tableName(meta.rawClassName ?? entity.name);
      }

      // 2. Column names
      const columns: ColumnMetadata[] = Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ?? [];
      for (const col of columns) {
        if (!col.nameExplicit) {
          col.name = ns.columnName(col.propertyKey!);
        }
      }
      // Also update entity metadata's columns reference
      if (meta.columns) {
        for (const col of meta.columns as unknown as ColumnMetadata[]) {
          if (!col.nameExplicit) {
            col.name = ns.columnName(col.propertyKey!);
          }
        }
      }

      // 3. Timestamp / DeletedAt / Version tokens — these store propertyKey,
      //    but are used as SQL column names. Update them if the naming strategy transforms them.
      const updateToken = (token: symbol) => {
        const propName = Reflect.getMetadata(token, entity) as string | undefined;
        if (propName) {
          // Find matching column to get its resolved DB name
          const matchingCol = columns.find((c) => c.propertyKey === propName);
          if (matchingCol && matchingCol.name !== propName) {
            Reflect.defineMetadata(token, matchingCol.name, entity);
          }
        }
      };
      updateToken(CREATE_TIMESTAMP_TOKEN);
      updateToken(UPDATE_TIMESTAMP_TOKEN);
      updateToken(DELETED_AT_TOKEN);
      updateToken(VERSION_TOKEN);

      // 4. Update Reflect metadata
      Reflect.defineMetadata(ENTITY_TOKEN, meta, entity);
      Reflect.defineMetadata(COLUMN_TOKEN, columns, entity.prototype);
    }
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
    this.connectionName = connectionName;
    const resolvedEntities = await resolveEntityGlobs(
      databaseClientOptions.entities ?? [],
    );
    this._entities = resolvedEntities as ClazzType<any>[];

    const client = this.client as any;
    await client.connect(databaseClientOptions, connectionName);

    await this.initializeFromConnection(databaseClientOptions, connectionName);
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
    const client = this.client as any;
    if (typeof client.hasConnection === "function" && !client.hasConnection(connectionName)) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        `Cannot attach EntityManager: no DatabaseClient connection registered under '${connectionName}'.`,
        `Register the connection first (e.g. DatabaseClient.getInstance().connect(opts, '${connectionName}')) before calling attach().`,
      );
    }

    this.connectionName = connectionName;
    this.isAttached = true;
    const baseOptions = client.getOptions(connectionName) as DatabaseClientOptions;
    // Spread collapses the discriminated union (postgres/mysql/sqlite share
    // most fields but `type` is per-variant), so we cast back. The runtime
    // shape is guaranteed because we only override fields that are valid on
    // every variant.
    const effective = {
      ...baseOptions,
      ...overrides,
      // Schema sync is owned by whoever first registered the connection;
      // disable it here so a second attach() never tries to re-DDL.
      synchronize: false,
    } as DatabaseClientOptions;

    if (effective.namingStrategy) {
      this.schemaRegistrar = new SchemaRegistrar(
        this.resolver,
        this._ctx,
        effective.namingStrategy,
      );
    }

    const resolvedEntities = await resolveEntityGlobs(effective.entities ?? []);
    this._entities = resolvedEntities as ClazzType<any>[];

    await this.initializeFromConnection(effective, connectionName);
    this.applyNamingStrategy(effective.namingStrategy);
    // synchronize: false ensures registerEntities() runs metadata setup
    // without firing any DDL — same per-EM state as register(), just no
    // schema mutation.
    await this.schemaRegistrar.registerEntities();
  }

  /**
   * Shared post-`client.connect()` setup: pick driver/dataSource for the
   * connector that DatabaseClient now holds under `connectionName`, then
   * configure QueryTracker / query timeout / tenant strategy / replication.
   * Used by both `connect()` (fresh pool) and `attach()` (reuse pool).
   */
  private async initializeFromConnection(
    databaseClientOptions: DatabaseClientOptions,
    connectionName: string,
  ): Promise<void> {
    const client = this.client as any;
    const connector = client.getConnection(connectionName);
    const { schema, queryTimeout, replication } = databaseClientOptions;

    // Use getType() if available, otherwise (legacy mock) fall back to client.type
    const dbType = (
      typeof client.getType === "function"
        ? client.getType(connectionName)
        : client.type
    ) as IDatabaseType;

    this.dbType = dbType;

    // Check DriverRegistry first for custom drivers
    const { DriverRegistry } = await import("../dialects/DriverRegistry");
    const customFactory = DriverRegistry.get(dbType);

    if (customFactory) {
      this.driver = customFactory.createDriver(connector, dbType, schema);
      this.dataSource = customFactory.createDataSource(connector);
    } else {
      // Built-in drivers
      switch (dbType) {
        case "mariadb":
        case "mysql": {
          const { MySqlDriver } = await import("../dialects/mysql/MySqlDriver");
          const { MySqlDataSource } = await import(
            "../dialects/mysql/MySqlDataSource"
          );
          this.driver = new MySqlDriver(connector, dbType);
          this.dataSource = new MySqlDataSource(connector);
          break;
        }
        case "postgres": {
          const { PostgresDriver } = await import(
            "../dialects/postgres/PostgresDriver"
          );
          const { PostgresDataSource } = await import(
            "../dialects/postgres/PostgresDataSource"
          );
          this.driver = new PostgresDriver(connector, dbType, schema);
          this.dataSource = new PostgresDataSource(connector);
          break;
        }
        case "sqlite": {
          const { SqliteDriver } = await import(
            "../dialects/sqlite/SqliteDriver"
          );
          const { SqliteDataSource } = await import(
            "../dialects/sqlite/SqliteDataSource"
          );
          this.driver = new SqliteDriver(connector);
          this.dataSource = new SqliteDataSource(connector);
          break;
        }
        default:
          throw new NotSupportedDatabaseTypeError();
      }
    }

    // Initialize QueryTracker (based on the logging options)
    this.initQueryTracker(databaseClientOptions);

    // Configure connection-level query timeout
    const isTimeoutSupported = queryTimeout && queryTimeout > 0;

    if (isTimeoutSupported) {
      this.defaultQueryTimeout = queryTimeout;
    }

    // Initialize TenantQueryStrategy
    this.tenantScope.configure(databaseClientOptions);

    // Initialize ReplicationRouter
    if (replication) {
      this.replication.initialize(replication);
    }
  }

  /**
   * Cleans up resources and shuts down.
   */
  public async propagateShutdown(options?: {
    gracefulTimeoutMs?: number;
    closeConnections?: boolean;
  }): Promise<boolean> {
    const gracefulTimeoutMs = options?.gracefulTimeoutMs ?? 0;
    const closeConnections = options?.closeConnections ?? false;

    let allQueriesCompleted = true;

    // 1. Wait for in-flight queries
    if (gracefulTimeoutMs > 0 && this.queryTracker) {
      const activeCount = this.queryTracker.activeQueryCount;
      if (activeCount > 0) {
        this.logger.info(
          `[Shutdown] Waiting for ${activeCount} active queries (timeout: ${gracefulTimeoutMs}ms)...`,
        );
        allQueriesCompleted = await this.queryTracker.waitForQueries(gracefulTimeoutMs);
        if (!allQueriesCompleted) {
          this.logger.warn(
            `[Shutdown] Timed out waiting for active queries. Forcing shutdown.`,
          );
        }
      }
    }

    // 2. Plugin shutdown (reverse installation order — LIFO)
    await this.pluginManager.shutdownAll();

    // 3. Clear event listeners / subscribers / dirty entities
    this.removeAllListeners();
    this.subscribers.length = 0;
    this.dirtyEntities.clear();
    this.cursorPkWarned.clear();
    this.rawQueryTenantWarned.clear();

    // 4. Clean up QueryTracker
    this.queryTracker?.removeAllListeners();
    this.queryTracker?.reset();
    this.queryTracker = null;

    // 5. Clean up ReplicationRouter
    this.replication.shutdown();

    // 6. Close the connection pool (when requested)
    if (closeConnections) {
      try {
        await this.client.close(this.connectionName);
      } catch (err) {
        this.logger.warn(
          `[Shutdown] Error closing connection '${this.connectionName}': ${err}`,
        );
      }
    }

    return allQueriesCompleted;
  }

  getNameStrategy<T>(clazz: ClazzType<T>): string {
    return clazz.name;
  }

  // ── QueryTracker ──────────────────────────────────────────

  private initQueryTracker(options: DatabaseClientOptions): void {
    const logging = options.logging;

    // logging: true → enable query SQL logging
    if (logging === true) {
      this.queryLoggingEnabled = true;
      return;
    }

    if (typeof logging === "object" && logging !== null) {
      const loggingOpts = logging as LoggingOptions;

      // queries: true → log generated SQL
      if (loggingOpts.queries) {
        this.queryLoggingEnabled = true;
      }

      // Disable when enableQueryTracking is explicitly set to false
      if (loggingOpts.enableQueryTracking === false) {
        this.queryTracker = null;
        return;
      }

      if (loggingOpts.nPlusOne || loggingOpts.slowQueryMs) {
        this.queryTracker = new QueryTracker({
          slowQueryMs: loggingOpts.slowQueryMs ?? null,
          enabled: loggingOpts.enableQueryTracking ?? true,
          maxLogEntries: loggingOpts.maxLogEntries,
          ttlMs: loggingOpts.ttlMs,
        });
      }
    }
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
    return this.readExecutor.pluck(entity, column, where);
  }

  async findWithCursor<T>(
    entity: ClazzType<T>,
    option: CursorPaginationOption<T> = {},
  ): Promise<CursorPaginationResult<T>> {
    return this.readExecutor.findWithCursor(entity, option);
  }

  async findAndCount<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<[T[], number]> {
    return this.readExecutor.findAndCount(entity, findOption);
  }

  /**
   * Returns an AsyncGenerator that yields entities in batches using LIMIT/OFFSET.
   * Works across all dialects without driver-level streaming support.
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
    let offset = 0;
    const effectiveBatchSize = Math.max(batchSize, 1);

    while (true) {
      const batch = await this.find<T>(entity, {
        ...options,
        limit: [offset, effectiveBatchSize],
      });

      if (batch.length === 0) break;

      for (const item of batch) {
        yield item;
      }

      if (batch.length < effectiveBatchSize) break;
      offset += effectiveBatchSize;
    }
  }

  /**
   * Streams entities in batches, yielding T[] arrays.
   * Each yielded value is an array of fully-deserialized entities with relations loaded.
   * Suitable for processing large datasets without loading all rows into memory.
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
    let offset = 0;
    const effectiveBatchSize = Math.max(batchSize, 1);

    while (true) {
      const batch = await this.find<T>(entity, {
        ...options,
        limit: [offset, effectiveBatchSize],
      });

      if (batch.length === 0) break;

      yield batch;

      if (batch.length < effectiveBatchSize) break;
      offset += effectiveBatchSize;
    }
  }

  async findWithPage<T>(
    entity: ClazzType<T>,
    option: PagePaginationOption<T> = {},
  ): Promise<PagePaginationResult<T>> {
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
    return this.entityFactory.preload(entity, partial);
  }

  // ── CRUD: Write ────────────────────────────────────────────

  async save<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<InstanceType<ClazzType<T>>> {
    return this.writeExecutor.save(entity, item);
  }

  async saveMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<InstanceType<ClazzType<T>>[]> {
    return this.writeExecutor.saveMany(entity, items);
  }

  async insertMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<{ affected: number }> {
    return this.writeExecutor.insertMany(entity, items);
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
    return this.writeExecutor.insertManyAndReturn(entity, items);
  }

  // ── CRUD: Delete ────────────────────────────────────────────

  async delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    return this.writeExecutor.delete(entity, criteria);
  }

  async deleteMany<T>(entity: ClazzType<T>, ids: unknown[]): Promise<DeleteResult> {
    return this.writeExecutor.deleteMany(entity, ids);
  }

  async clear<T>(entity: ClazzType<T>): Promise<void> {
    return this.writeExecutor.clear(entity);
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
    return this.writeExecutor.update(entity, where, data);
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
    return this.writeExecutor.updateMany(entity, data, options);
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
    return this.writeExecutor.increment(entity, where, column, by);
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
    return this.writeExecutor.decrement(entity, where, column, by);
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
    let entity: ClazzType<T>;
    let aliasName: string;
    if (isEntityRef(entityOrRef)) {
      entity = entityOrRef._entity;
      aliasName = entityOrRef._alias;
    } else {
      entity = entityOrRef;
      aliasName = alias ?? entity.name;
    }
    const meta = this.resolver.resolveEntityMetadata(entity);
    if (!meta) {
      throw new EntityMetadataNotFoundError(entity.name);
    }
    const propMap = this.buildPropertyToColumnMap(meta);
    const dialectExpr = createDialectExpression(this._ctx.getDialect());
    return new UpdateQueryBuilder<T>(this, entity, aliasName, propMap, dialectExpr);
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
  ): Promise<{ affected: number }> {
    return this.writeExecutor.executeBuilderUpdate(entity, setEntries, whereConditions, orderBySql, limit);
  }

  async softDelete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    return this.writeExecutor.softDelete(entity, criteria);
  }

  async restore<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    return this.writeExecutor.restore(entity, criteria);
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
   * @returns `{ affected }` — the driver-reported affected-row count.
   *
   * MySQL caveat: for `INSERT … ON DUPLICATE KEY UPDATE`, MySQL reports
   * `affectedRows` as 1 when a new row is inserted, 2 when an existing row
   * is updated, and 0 when the existing row's values are unchanged. This
   * count is returned as-is (not normalized), so callers should not treat
   * it as a literal row count on MySQL. PostgreSQL/SQLite report 1 for
   * both insert and update.
   */
  async upsert<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    return this.writeExecutor.upsert(entity, data, conflictColumns);
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
   * @returns `{ affected }` — 1 if a new row was inserted, 0 if a
   * matching row already existed.
   */
  async insertIgnore<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    return this.writeExecutor.insertIgnore(entity, data, conflictColumns);
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
    return this.writeExecutor.batchUpsert(entity, items, conflictColumns);
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
    return this.explainHandler.explain(entity, findOption);
  }

  // ── Utilities ──────────────────────────────────────────────

  private validateCriteriaKeys<T>(
    metadata: { target?: ClazzType<any>; columns: ColumnMetadata[] },
    criteria: WhereClause<T>,
    entityName: string,
  ): void {
    // Derive the valid key set from the SAME source the SQL builder uses
    // (buildPropertyToColumnMap), so the guard accepts every key the builder
    // can resolve and the two can never drift. This includes @Column property
    // and DB names plus @ManyToOne/@OneToOne FK shadow properties (e.g.
    // `userId` → `user_id`); without the FK entries, filtering a bulk
    // update/delete by a relation FK threw "Unknown column" even though the
    // builder resolves it fine (#353).
    const validNames = new Set<string>();
    for (const col of metadata.columns) {
      if (col.propertyKey) validNames.add(col.propertyKey);
      if (col.name) validNames.add(col.name);
    }
    for (const [prop, col] of this.buildPropertyToColumnMap(metadata)) {
      validNames.add(prop);
      if (col) validNames.add(col);
    }
    for (const key of Object.keys(criteria as object)) {
      const value = (criteria as any)[key];
      // Skip functions (hook methods) and undefined/null values
      if (typeof value === "function" || value === undefined || value === null) continue;
      if (!validNames.has(key)) {
        throw new InvalidQueryError(
          `Unknown column "${key}" in criteria for entity "${entityName}".`,
          `Valid columns: ${[...validNames].join(", ")}`,
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
   * jsonb, so the same path is safe there.
   */
  private applyWriteTransform(col: ColumnMetadata, rawValue: any): any {
    if (col.transformer?.to) return col.transformer.to(rawValue);
    if (col.options?.type) {
      const regTo = ColumnTypeRegistry.getInstance().getTransformer(col.options.type)?.to;
      if (regTo) return regTo(rawValue);
      if (isJsonColumnType(col.options.type)) {
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
   * Engine delegator — implementation lives in {@link TenantScopeManager}.
   * Kept on the facade so `_ctx` routing and internal callers stay interceptable.
   */
  private buildTenantWhereClause<T>(
    entity: ClazzType<T>,
    tableAliasOrName?: string,
  ): Sql | null {
    return this.tenantScope.buildTenantWhereClause(entity, tableAliasOrName);
  }

  /** Engine delegator — implementation lives in {@link TenantScopeManager}. */
  private applyTenantColumnOnInsert<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): void {
    this.tenantScope.applyTenantColumnOnInsert(entity, item);
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


