/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { ClazzType, Logger, resolveEntityGlobs, generateUUIDv7 } from "../utils";
import { ColumnMetadata } from "../scanner";
import { DatabaseClient } from "../DatabaseClient";
import { ISqlDriver } from "../dialects/SqlDriver";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { FindOption, LockMode, UpdateData, UpdateManyOptions, WhereClause } from "../dialects/FindOption";
import { resolveWhereClause } from "./WhereResolver";
import { ISelectOption } from "../dialects/ISelectOption";
import { IDataSource } from "../dialects/IDataSource";
import sql, { Sql, join, raw } from "sql-template-tag";
import { BaseRepository } from "./BaseRepository";
import { BaseEntityManager } from "./BaseEntityManager";
import { QueryResult } from "../types/QueryResult";
import { EntityResult } from "../types/EntityResult";
import { DeleteResult } from "../types/DeleteResult";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { BaseRawQueryBuilder } from "./BaseRawQueryBuilder";
import { Conditions } from "./Conditions";
import { ResultTransformerFactory } from "./ResultTransformerFactory";
import { DatabaseClientOptions, validateDatabaseClientOptions } from "./DatabaseClientOptions";
import { MetadataContext } from "../metadata/MetadataContext";
import { injectLazyProxy } from "./LazyLoader";
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
import { ReplicationManager } from "./ReplicationManager";
import { CascadeHandler } from "./CascadeHandler";
import { RelationLoader } from "./RelationLoader";
import { SchemaRegistrar } from "./SchemaRegistrar";
import { ExplainQueryHandler } from "./ExplainQueryHandler";
import { AggregateQueryHandler } from "./AggregateQueryHandler";
import {
  TenantQueryStrategy,
  SearchPathStrategy,
  SchemaQualifiedStrategy,
  TenantColumnStrategy,
  DatabaseStrategy,
} from "./TenantQueryStrategy";
import {
  StingerloomPlugin,
  InstalledPlugin,
} from "./plugin/StingerloomPlugin";
import { PluginContext } from "./plugin/PluginContext";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { DefaultNamingStrategy, NamingStrategy } from "./generators/NamingStrategy";
import { ENTITY_TOKEN, EntityMetadata } from "../decorators/Entity";
import { COLUMN_TOKEN } from "../decorators/Column";
import { InheritanceResolver } from "./InheritanceResolver";
import { CREATE_TIMESTAMP_TOKEN } from "../decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../decorators/UpdateTimestamp";
import { DELETED_AT_TOKEN } from "../decorators/DeletedAt";
import {
  getTenantColumnMetadata,
  isNonTenantEntity,
} from "../decorators/TenantColumn";
import { VERSION_TOKEN } from "../decorators/Version";
import { deserializeEntity } from "./deserializer/DeserializeEntity";
import type { WriteBuffer } from "./plugin/buffer/WriteBuffer";
import type { BufferPluginOptions } from "./plugin/buffer/BufferPreview";
import type { RawPipeline, RawPipelineOptions } from "./plugin/raw-pipeline/RawPipeline";
import { createDialectExpression } from "../dialects/DialectExpression";
import { SelectQueryBuilder, isEntityRef } from "./SelectQueryBuilder";
import type { EntityRef } from "./SelectQueryBuilder";
import { UpdateQueryBuilder } from "./UpdateQueryBuilder";
import { CompiledQuery, p as createPlaceholder, PlaceholderMarker } from "./CompiledQuery";

// ── Public Metadata View Types (#233) ────────────────────

export interface EntityMetadataView {
  tableName: string;
  columns: ColumnMetadataView[];
  relations: RelationMetadataView[];
  indexes: any[];
  deletedAtColumn: string | null;
  createTimestampColumn: string | null;
  updateTimestampColumn: string | null;
  versionColumn: string | null;
}

export interface ColumnMetadataView {
  propertyKey: string;
  columnName: string;
  type: string;
  nullable: boolean;
  primary: boolean;
  unique: boolean;
  default?: any;
  length?: number;
}

export interface RelationMetadataView {
  type: "ManyToOne" | "OneToMany" | "ManyToMany" | "OneToOne";
  propertyKey: string;
  target: ClazzType<any>;
  joinColumn: string | null;
  eager: boolean;
}

/**
 * Transaction options for configurable retry behavior.
 */
export interface TransactionOptions {
  /** If true, automatically retry the transaction on deadlock. */
  retryOnDeadlock?: boolean;
  /** Maximum number of retries on deadlock (default: 3). */
  maxRetries?: number;
  /** Delay between retries in milliseconds (default: 100). */
  retryDelayMs?: number;
}

/**
 * Checks if an error is a deadlock error based on dialect-specific error codes.
 * - MySQL: errno 1213 (ER_LOCK_DEADLOCK)
 * - PostgreSQL: code 40P01 (deadlock_detected)
 * - SQLite: code SQLITE_BUSY / "database is locked"
 */
function isDeadlockError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as any;
  // MySQL: errno 1213
  if (err.errno === 1213 || err.code === "ER_LOCK_DEADLOCK") return true;
  // PostgreSQL: code 40P01
  if (err.code === "40P01") return true;
  // SQLite: SQLITE_BUSY
  if (err.code === "SQLITE_BUSY" || err.message?.includes("database is locked")) return true;
  return false;
}

/**
 * Converts a Date to the MySQL/MariaDB-compatible 'YYYY-MM-DD HH:MM:SS' format.
 * ISO 8601 formatting can be rejected by MariaDB strict mode.
 */
function formatDateTimeForSQL(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export class EntityManager implements BaseEntityManager {
  private _entities: ClazzType<any>[] = [];
  private readonly logger = new Logger(EntityManager.name);
  private driver?: ISqlDriver;
  private dataSource?: IDataSource;
  private dirtyEntities: Set<InstanceType<ClazzType<any>>> = new Set();
  private txDirtyEntities: WeakMap<TransactionSessionManager, Set<InstanceType<ClazzType<any>>>> = new WeakMap();
  private readonly eventEmitter = new EntityEventEmitter();
  private readonly subscribers: EntitySubscriber<any>[] = [];
  private readonly cursorPkWarned = new Set<string>();
  private readonly rawQueryTenantWarned = new Set<string>();
  private queryTracker: QueryTracker | null = null;
  private defaultQueryTimeout: number | undefined;
  private queryLoggingEnabled = false;
  private tenantStrategy: TenantQueryStrategy = new SearchPathStrategy();
  private tenantColumnConfig: {
    name: string;
    type: "varchar" | "uuid" | "int" | "bigint";
    length?: number;
  } | null = null;

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
  private readonly _plugins = new Map<string, InstalledPlugin>();
  private _pluginContext: PluginContext | null = null;

  // ── Extracted handlers ──────────────────────────────────────────

  private readonly resolver = new RelationMetadataResolver();
  private readonly inheritanceResolver = new InheritanceResolver();
  private readonly replication = new ReplicationManager();

  /** @internal Adapter that exposes EntityManager internals to the extracted handler classes. */
  private readonly _ctx: EntityManagerInternals = {
    wrap: (col) => this.wrap(col),
    wrapTable: (tableName) => this.wrapTable(tableName),
    isMySqlFamily: () => this.isMySqlFamily(),
    isPostgres: () => this.isPostgres(),
    getDriver: () => this.driver,
    getEntities: () => this._entities,
    getSynchronize: () =>
      this.isAttached
        ? false
        : (this.client.getOptions(this.connectionName).synchronize ??
            false) as boolean | "safe" | "dry-run",
    getDialect: () => {
      if (this.isMySqlFamily()) return "mysql" as const;
      if (this.isPostgres()) return "postgres" as const;
      return "sqlite" as const;
    },
    getSchema: () => this.client.getOptions(this.connectionName).schema,
    getConnection: () => this.connection,
    executeInTransaction: (fn, s, r) => this.executeInTransaction(fn, s, r),
    executeReadOnly: (fn, opts) => this.executeReadOnly(fn, opts),
    beginTrackQuery: () => this.beginTrackQuery(),
    trackQuery: (e, s, m) => this.trackQuery(e, s, m),
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
    saveWithSession: (e, i, s) => this.saveInternal(e, i, s),
    find: (e, o) => this.find(e, o),
    delete: (e, c) => this.delete(e, c),
    getTenantColumnConfig: () => this.tenantColumnConfig,
    buildTenantWhereClause: (e, alias) => this.buildTenantWhereClause(e, alias),
  };

  private readonly cascadeHandler = new CascadeHandler(this.resolver, this._ctx);
  private readonly relationLoader = new RelationLoader(this.resolver, this._ctx);
  private schemaRegistrar = new SchemaRegistrar(this.resolver, this._ctx);
  private readonly explainHandler = new ExplainQueryHandler(this.resolver, this._ctx);
  private readonly aggregateHandler = new AggregateQueryHandler(this.resolver, this._ctx);

  // ── Lifecycle ──────────────────────────────────────────

  public async register(
    databaseClientOptions: DatabaseClientOptions,
    connectionName = "default",
  ) {
    validateDatabaseClientOptions(databaseClientOptions);

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
    if (databaseClientOptions.tenantStrategy === "schema_qualified") {
      this.tenantStrategy = new SchemaQualifiedStrategy();
    } else if (databaseClientOptions.tenantStrategy === "tenant_column") {
      this.tenantStrategy = new TenantColumnStrategy(
        databaseClientOptions.tenantColumnName ?? "tenant_id",
      );
      this.tenantColumnConfig = {
        name: databaseClientOptions.tenantColumnName ?? "tenant_id",
        type: databaseClientOptions.tenantColumnType ?? "varchar",
        length:
          databaseClientOptions.tenantColumnType == null ||
          databaseClientOptions.tenantColumnType === "varchar"
            ? databaseClientOptions.tenantColumnLength ?? 64
            : undefined,
      };
    } else if (databaseClientOptions.tenantStrategy === "database") {
      this.tenantStrategy = new DatabaseStrategy();
    }

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
    const pluginEntries = [...this._plugins.values()].reverse();
    for (const { plugin } of pluginEntries) {
      if (plugin.shutdown) {
        try {
          await plugin.shutdown();
        } catch (err) {
          this.logger.warn(
            `[Shutdown] Plugin "${plugin.name}" shutdown error: ${err}`,
          );
        }
      }
    }
    this._plugins.clear();
    this._pluginContext = null;

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
    let info = queryInfo;
    for (const { plugin } of this._plugins.values()) {
      if (plugin.beforeQuery) {
        const result = plugin.beforeQuery(info);
        if (result) info = result;
      }
    }
    return info;
  }

  /** @internal Notify installed plugins after a query executes. */
  notifyPluginAfterQuery(queryInfo: import("./plugin/StingerloomPlugin").QueryInfo, result: any, durationMs: number): void {
    for (const { plugin } of this._plugins.values()) {
      if (plugin.afterQuery) {
        plugin.afterQuery(queryInfo, result, durationMs);
      }
    }
  }

  /** @internal Notify installed plugins before a transaction. */
  private notifyPluginBeforeTransaction(isolationLevel?: string): void {
    for (const { plugin } of this._plugins.values()) {
      if (plugin.beforeTransaction) {
        plugin.beforeTransaction(isolationLevel);
      }
    }
  }

  /** @internal Notify installed plugins after a transaction. */
  private notifyPluginAfterTransaction(committed: boolean): void {
    for (const { plugin } of this._plugins.values()) {
      if (plugin.afterTransaction) {
        plugin.afterTransaction(committed);
      }
    }
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
    this.subscribers.push(subscriber);
  }

  removeSubscriber(subscriber: EntitySubscriber<any>): void {
    const idx = this.subscribers.indexOf(subscriber);
    if (idx !== -1) {
      this.subscribers.splice(idx, 1);
    }
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
    // Idempotent: skip if already installed
    if (this._plugins.has(plugin.name)) {
      return this as this & TApi;
    }

    // Check dependencies
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this._plugins.has(dep)) {
          throw new OrmError(
            OrmErrorCode.PLUGIN_DEPENDENCY_MISSING,
            `Plugin "${plugin.name}" requires "${dep}" to be installed first`,
            `Call em.extend(${dep}Plugin) before em.extend(${plugin.name}Plugin)`,
          );
        }
      }
    }

    // Create context (lazy singleton)
    const ctx = this.getPluginContext();

    // Install
    const api = (plugin.install(ctx) ?? {}) as Record<string, any>;

    // Check for conflicts with existing properties
    const reserved = new Set(Object.getOwnPropertyNames(EntityManager.prototype));
    for (const key of Object.keys(api)) {
      // Allow plugins to override placeholder stubs (e.g. mutate())
      if (EntityManager.PLUGIN_PLACEHOLDERS.has(key)) {
        continue;
      }
      if (key in this || reserved.has(key)) {
        throw new OrmError(
          OrmErrorCode.PLUGIN_CONFLICT,
          `Plugin "${plugin.name}" method "${key}" conflicts with an existing EntityManager member`,
          `Rename the "${key}" method in the plugin's install() return object`,
        );
      }
    }

    // Mix API methods into this instance
    for (const [key, value] of Object.entries(api)) {
      (this as any)[key] = value;
    }

    // Store
    this._plugins.set(plugin.name, { plugin, api });

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
    return this._plugins.has(name);
  }

  /**
   * Get a plugin's API object by name.
   * Returns undefined if the plugin is not installed.
   */
  getPluginApi<T = unknown>(name: string): T | undefined {
    const installed = this._plugins.get(name);
    return installed ? (installed.api as T) : undefined;
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
   */
  private getPluginContext(): PluginContext {
    if (!this._pluginContext) {
      const self = this;
      this._pluginContext = {
        get em() {
          return self;
        },
        get driver() {
          return self.driver;
        },
        get events() {
          return self.eventEmitter;
        },
        get connectionName() {
          return self.connectionName;
        },
        addSubscriber: (s) => this.addSubscriber(s),
        removeSubscriber: (s) => this.removeSubscriber(s),
        getEntities: () => this._entities,
        getPlugin: <T = unknown>(name: string) => this.getPluginApi<T>(name),
        isMySqlFamily: () => this.isMySqlFamily(),
        isPostgres: () => this.isPostgres(),
        isSqlite: () => this.isSqlite(),
        wrap: (id) => this.wrap(id),
        wrapTable: (t) => this.wrapTable(t),
        executeInTransaction: (fn) => this.executeInTransaction(fn),
        executeReadOnly: (fn) => this.executeReadOnly(fn),
        getEntityMetadata: (entity) => this.getEntityMetadata(entity),
        registerPlaceholder: (name) => EntityManager.registerPluginPlaceholder(name),
      };
    }
    return this._pluginContext;
  }

  private async notifySubscribers<T>(
    entityClass: new (...args: any[]) => T,
    method: keyof EntitySubscriber<T>,
    arg?: any,
  ): Promise<void> {
    for (const sub of this.subscribers) {
      if (sub.listenTo() === entityClass && typeof sub[method] === "function") {
        await (sub[method] as Function)(arg);
      }
    }
  }

  /**
   * True iff any registered subscriber for `entityClass` implements `method`.
   * Used to skip the `databaseEntity` pre-read on entities where no
   * subscriber actually wants the snapshot.
   */
  private hasSubscriberFor<T>(
    entityClass: new (...args: any[]) => T,
    method: keyof EntitySubscriber<T>,
  ): boolean {
    for (const sub of this.subscribers) {
      if (sub.listenTo() === entityClass && typeof sub[method] === "function") {
        return true;
      }
    }
    return false;
  }

  private async notifyTransactionSubscribers(
    method: keyof EntitySubscriber<any>,
  ): Promise<void> {
    for (const sub of this.subscribers) {
      if (typeof sub[method] === "function") {
        await (sub[method] as Function)();
      }
    }
  }

  // ── CRUD: Read ────────────────────────────────────────────

  async findOne<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T | null> {
    return this.findOneInternal(entity, findOption);
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

  private async findOneInternal<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
    existingSession?: TransactionSessionManager,
  ): Promise<T | null> {
    const result = await this.findInternal<T>(entity, { ...findOption, limit: 1 }, existingSession);
    if (result === undefined || result === null) {
      return null;
    }
    if (Array.isArray(result)) {
      return (result[0] as T) ?? null;
    }
    return result as T;
  }

  async find<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<T[]> {
    const result = await this.findInternal(entity, findOption);
    if (result === undefined || result === null) return [];
    if (Array.isArray(result)) return result as T[];
    return [result as T];
  }

  private async findInternal<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
    existingSession?: TransactionSessionManager,
  ): Promise<EntityResult<T>> {
    const { select, orderBy, where, take, skip, groupBy, having } = findOption;
    const { limit } = findOption;

    // Validate pagination values
    if (skip !== undefined && skip < 0) {
      throw new InvalidQueryError(
        `"skip" must be a non-negative integer, but received ${skip}`,
        "Ensure skip is >= 0",
      );
    }
    if (take !== undefined && take < 0) {
      throw new InvalidQueryError(
        `"take" must be a non-negative integer, but received ${take}`,
        "Ensure take is >= 0",
      );
    }
    if (limit !== undefined) {
      if (Array.isArray(limit)) {
        const [off, cnt] = limit;
        if (off < 0) {
          throw new InvalidQueryError(
            `"limit" offset must be non-negative, but received ${off}`,
            "Ensure the first element of the limit tuple is >= 0",
          );
        }
        if (cnt < 0) {
          throw new InvalidQueryError(
            `"limit" count must be non-negative, but received ${cnt}`,
            "Ensure the second element of the limit tuple is >= 0",
          );
        }
      } else if (typeof limit === "number" && limit < 0) {
        throw new InvalidQueryError(
          `"limit" must be non-negative, but received ${limit}`,
          "Ensure limit is >= 0",
        );
      }
    }

    const readNode = this.getReadNode(findOption.useMaster);
    const effectiveTimeout = findOption.timeout ?? this.defaultQueryTimeout;

    return this.executeReadOnly(async (session) => {
      const resultTransformer = ResultTransformerFactory.create();

      const metadata = this.resolver.resolveEntityMetadata(entity);

      if (!metadata) {
        throw new EntityMetadataNotFoundError(entity.name);
      }

      // ── Detect the inheritance strategy early ──
      const inheritanceStrategy = this.inheritanceResolver.getStrategy(entity);
      const isTPTChild = inheritanceStrategy === "JOINED" && this.inheritanceResolver.isChildEntity(entity);
      const isTPTPolymorphic = inheritanceStrategy === "JOINED" && this.inheritanceResolver.isPolymorphicQuery(entity);
      const isTPCPolymorphic = inheritanceStrategy === "TABLE_PER_CLASS" && this.inheritanceResolver.isPolymorphicQuery(entity);

      const qb = RawQueryBuilderFactory.create();

      const selectMap: string[] = [];
      const whereMap: Sql[] = [];
      const orderByMap: Array<{ column: string; direction: "ASC" | "DESC" }> =
        [];

      // Collect ManyToOne relations to eager-load
      const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
      const eagerRelations = manyToOneRelations.filter((rel) => {
        const isEager = rel.option?.eager === true;
        const isInRelations = findOption.relations?.includes(
          rel.columnName,
        );
        return isEager || isInRelations;
      });

      // Collect OneToOne relations to eager-load (owning side — the side with joinColumn)
      const oneToOneRelations = this.resolver.resolveOneToOneMetadata(entity);
      const eagerOneToOneRelations = oneToOneRelations.filter((rel) => {
        if (!rel.joinColumn) return false;
        const isEager = rel.option?.eager === true;
        const isInRelations = findOption.relations?.includes(
          rel.propertyKey,
        );
        return isEager || isInRelations;
      });

      const hasEagerJoins =
        eagerRelations.length > 0 || eagerOneToOneRelations.length > 0
        || isTPTChild || isTPTPolymorphic;

      const tableName = metadata.name!;

      // Build property-to-column map once and reuse throughout findInternal
    const propToCol = this.buildPropertyToColumnMap(metadata);

    // TPT child: build SELECT by separating child-table columns (PK + own) from parent columns
      if (isTPTChild) {
        const root = this.inheritanceResolver.getRoot(entity)!;
        const rootMeta = this.resolver.resolveEntityMetadata(root);
        if (rootMeta) {
          const rootTableName = rootMeta.name!;
          const rootColNames = new Set(
            rootMeta.columns.map((c: any) => c.name),
          );
          const pkColNames = new Set(
            metadata.columns
              .filter((c: any) => c.options?.primary)
              .map((c: any) => c.name),
          );

          // Columns that physically exist on the child table: PK + own (excluding parent-only columns)
          for (const col of metadata.columns) {
            const isPk = pkColNames.has(col.name!);
            const isRootOnly = rootColNames.has(col.name!) && !isPk;
            if (!isRootOnly) {
              selectMap.push(
                `${this.wrap(tableName)}.${this.wrap(col.name!)}`,
              );
            }
          }

          // Non-PK columns from the parent table
          for (const col of rootMeta.columns) {
            if (pkColNames.has(col.name)) continue;
            selectMap.push(
              `${this.wrap(rootTableName)}.${this.wrap(col.name!)}`,
            );
          }
        }
      } else if (select) {
        const selectedColumns = this.resolveSelectColumns<T>(select)
          .map((prop) => propToCol.get(prop) ?? prop);
        if (hasEagerJoins) {
          selectMap.push(
            ...selectedColumns.map(
              (col) => `${this.wrap(tableName)}.${this.wrap(col)}`,
            ),
          );
        } else {
          selectMap.push(...selectedColumns.map((col) => this.wrap(col)));
        }
      } else {
        if (hasEagerJoins) {
          selectMap.push(
            ...metadata.columns.map(
              (column) => `${this.wrap(tableName)}.${this.wrap(column.name!)}`,
            ),
          );
        } else {
          selectMap.push(
            ...metadata.columns.map((column) => this.wrap(column.name!)),
          );
        }
      }

      // TPT polymorphic: add each child table's unique columns to SELECT (with a prefix alias)
      if (isTPTPolymorphic) {
        const pk = metadata.columns.find((c: any) => c.options?.primary);
        const children = this.inheritanceResolver
          .getConcreteEntities(entity)
          .filter((c) => c !== entity);
        for (const ChildEntity of children) {
          const childMeta = this.resolver.resolveEntityMetadata(ChildEntity);
          if (!childMeta || !pk) continue;
          const childTableName = childMeta.name!;
          const ownCols = this.inheritanceResolver.getOwnColumns(ChildEntity);
          for (const col of ownCols) {
            selectMap.push(
              `${this.wrap(childTableName)}.${this.wrap(col.name!)} AS ${this.wrap(`${childTableName}_${col.name!}`)}`,
            );
          }
        }
      }

      // Add eager ManyToOne relation columns to SELECT.
      //
      // Each relation gets its own table alias (`rel.columnName` — the
      // property name like "assignee" / "reporter") so that two relations
      // pointing at the same entity (e.g. Issue → assignee + reporter, both
      // → User) emit `LEFT JOIN user AS assignee` and `LEFT JOIN user AS
      // reporter` instead of two `LEFT JOIN user AS user`. The latter
      // tripped MariaDB's "Not unique table/alias" error.
      for (const rel of eagerRelations) {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relAlias = rel.columnName;
        for (const col of relatedMetadata.columns) {
          const alias = `${rel.columnName}_${col.name}`;
          selectMap.push(
            `${this.wrap(relAlias)}.${this.wrap(col.name!)} AS ${this.wrap(alias)}`,
          );
        }
      }

      // Add eager OneToOne relation columns to SELECT — same per-property alias.
      for (const rel of eagerOneToOneRelations) {
        const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relAlias = rel.propertyKey;
        for (const col of relatedMetadata.columns) {
          const alias = `${rel.propertyKey}_${col.name}`;
          selectMap.push(
            `${this.wrap(relAlias)}.${this.wrap(col.name!)} AS ${this.wrap(alias)}`,
          );
        }
      }

      // TPT child: qualify a column with the parent table if it belongs to the parent, else with the child table
      let tptQualifyColumn: ((dbCol: string) => string) | undefined;
      if (isTPTChild) {
        const tptRoot = this.inheritanceResolver.getRoot(entity)!;
        const tptRootMeta = this.resolver.resolveEntityMetadata(tptRoot);
        if (tptRootMeta) {
          const tptRootTableName = tptRootMeta.name!;
          const tptPkNames = new Set(
            metadata.columns
              .filter((c: any) => c.options?.primary)
              .map((c: any) => c.name),
          );
          const tptRootOnlyCols = new Set(
            tptRootMeta.columns
              .filter((c: any) => !tptPkNames.has(c.name))
              .map((c: any) => c.name),
          );
          tptQualifyColumn = (dbCol: string) => {
            if (tptRootOnlyCols.has(dbCol)) {
              return `${this.wrap(tptRootTableName)}.${this.wrap(dbCol)}`;
            }
            return `${this.wrap(tableName)}.${this.wrap(dbCol)}`;
          };
        }
      }

      whereMap.push(
        ...resolveWhereClause(where, {
          wrapColumn: (n) => this.wrap(n),
          qualified: hasEagerJoins,
          tableName: hasEagerJoins ? tableName : undefined,
          dialect: this._ctx.getDialect(),
          dialectExpression: createDialectExpression(this._ctx.getDialect()),
          propertyToColumn: propToCol,
          qualifyColumn: tptQualifyColumn,
        }),
      );

      // STI: when querying a child entity, add a discriminator WHERE condition
      if (inheritanceStrategy === "SINGLE_TABLE" && this.inheritanceResolver.isChildEntity(entity)) {
        const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
        const discVal = this.inheritanceResolver.getDiscriminatorValue(entity);
        if (discCol && discVal) {
          const col = hasEagerJoins
            ? `${this.wrap(tableName)}.${this.wrap(discCol.name)}`
            : this.wrap(discCol.name);
          whereMap.push(Conditions.equals(col, discVal));
        }
      }

      // If an @DeletedAt column exists, automatically add a WHERE deleted_at IS NULL condition
      const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
      if (deletedAtColumn && !(findOption as any).withDeleted) {
        if (hasEagerJoins) {
          whereMap.push(
            Conditions.isNull(
              `${this.wrap(tableName)}.${this.wrap(deletedAtColumn)}`,
            ),
          );
        } else {
          whereMap.push(Conditions.isNull(this.wrap(deletedAtColumn)));
        }
      }

      // Tenant scoping under the "tenant_column" strategy. Skipped when the
      // caller explicitly opts out via `findOption.withoutTenantScope`.
      if (!findOption.withoutTenantScope) {
        const tenantPredicate = this.buildTenantWhereClause(
          entity,
          hasEagerJoins ? tableName : undefined,
        );
        if (tenantPredicate) {
          whereMap.push(tenantPredicate);
        }
      }

      for (const key in orderBy) {
        const value = orderBy[key];
        if (value) {
          const dbCol = propToCol.get(key) ?? key;
          orderByMap.push({ column: this.wrap(dbCol), direction: value });
        }
      }

      // TPC polymorphic: build the FROM clause from a UNION ALL subquery
      if (isTPCPolymorphic) {
        const allEntities = this.inheritanceResolver.getConcreteEntities(entity);
        const allHierarchyCols = this.inheritanceResolver
          .getAllHierarchyColumns(entity)
          .map((c) => c.name!);
        const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
        const discColName = discCol?.name ?? "dtype";

        const subQueries: Sql[] = [];
        for (const ent of allEntities) {
          const entMeta = this.resolver.resolveEntityMetadata(ent);
          if (!entMeta) continue;
          const entTableName = entMeta.name!;
          const entColNames = new Set(
            entMeta.columns.map((c: any) => c.name),
          );
          const discVal =
            this.inheritanceResolver.getDiscriminatorValue(ent) ?? ent.name;

          const colExprs: Sql[] = allHierarchyCols.map((colName) =>
            entColNames.has(colName)
              ? sql`${raw(this.wrap(colName))}`
              : sql`NULL AS ${raw(this.wrap(colName))}`,
          );
          colExprs.push(sql`${discVal} AS ${raw(this.wrap(discColName))}`);

          const subSql = sql`SELECT ${join(colExprs, ", ")} FROM ${raw(this.wrapTable(entTableName))}`;
          subQueries.push(subSql);
        }

        const unionSql = join(subQueries, " UNION ALL ");
        qb.select(["*"]).from(sql`(${unionSql})`, this.wrap("_tpc"));
      } else if (findOption.distinct) {
        qb.selectDistinct(selectMap).from(this.wrapTable(tableName));
      } else {
        qb.select(selectMap).from(this.wrapTable(tableName));
      }

      // TPT child: INNER JOIN the parent table
      if (isTPTChild) {
        const root = this.inheritanceResolver.getRoot(entity)!;
        const rootMeta = this.resolver.resolveEntityMetadata(root);
        if (rootMeta) {
          const pk = metadata.columns.find((c: any) => c.options?.primary);
          if (pk) {
            const rootTableName = rootMeta.name!;
            const joinCond = sql`${raw(this.wrap(tableName))}.${raw(this.wrap(pk.name!))} = ${raw(this.wrap(rootTableName))}.${raw(this.wrap(pk.name!))}`;
            qb.innerJoin(
              this.wrapTable(rootTableName),
              this.wrap(rootTableName),
              joinCond,
            );
          }
        }
      }

      // TPT polymorphic: LEFT JOIN every child table
      if (isTPTPolymorphic) {
        const pk = metadata.columns.find((c: any) => c.options?.primary);
        const children = this.inheritanceResolver
          .getConcreteEntities(entity)
          .filter((c) => c !== entity);
        for (const ChildEntity of children) {
          const childMeta = this.resolver.resolveEntityMetadata(ChildEntity);
          if (!childMeta || !pk) continue;
          const childTableName = childMeta.name!;
          const joinCond = sql`${raw(this.wrap(tableName))}.${raw(this.wrap(pk.name!))} = ${raw(this.wrap(childTableName))}.${raw(this.wrap(pk.name!))}`;
          qb.leftJoin(
            this.wrapTable(childTableName),
            this.wrap(childTableName),
            joinCond,
          );
        }
      }

      // Eager ManyToOne LEFT JOIN
      for (const rel of eagerRelations) {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedTableName = relatedMetadata.name || RelatedEntity.name;
        const joinColumn = rel.joinColumn ?? rel.columnName;

        const relatedPk = relatedMetadata.columns.find(
          (col: any) => col.options?.primary,
        );
        if (!relatedPk) continue;

        // TPT child: if the FK column lives on the parent table, qualify it with the parent table
        let fkTableName = tableName;
        if (isTPTChild) {
          const root = this.inheritanceResolver.getRoot(entity)!;
          const rootMeta = this.resolver.resolveEntityMetadata(root);
          if (rootMeta) {
            const rootColNames = new Set(rootMeta.columns.map((c: any) => c.name));
            if (rootColNames.has(joinColumn)) {
              fkTableName = rootMeta.name!;
            }
          }
        }

        // Use the property name as the JOIN alias so multiple relations to
        // the same target entity (e.g. assignee + reporter → User) get
        // distinct aliases.
        const relAlias = rel.columnName;
        const joinCondition = sql`${raw(this.wrap(fkTableName))}.${raw(this.wrap(joinColumn))} = ${raw(this.wrap(relAlias))}.${raw(this.wrap(relatedPk.name!))}`;
        qb.leftJoin(
          this.wrapTable(relatedTableName),
          this.wrap(relAlias),
          joinCondition,
        );
      }

      // OneToOne Eager LEFT JOIN
      for (const rel of eagerOneToOneRelations) {
        const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedTableName = relatedMetadata.name || RelatedEntity.name;
        const joinColumn = rel.joinColumn!;

        const relatedPk = relatedMetadata.columns.find(
          (col: any) => col.options?.primary,
        );
        if (!relatedPk) continue;

        const relAlias = rel.propertyKey;
        const joinCondition = sql`${raw(this.wrap(tableName))}.${raw(this.wrap(joinColumn))} = ${raw(this.wrap(relAlias))}.${raw(this.wrap(relatedPk.name!))}`;
        qb.leftJoin(
          this.wrapTable(relatedTableName),
          this.wrap(relAlias),
          joinCondition,
        );
      }

      qb.where(whereMap);

      // GROUP BY / HAVING
      if (groupBy && groupBy.length > 0) {
        const groupByColumns = (groupBy as string[]).map((col) =>
          hasEagerJoins
            ? `${this.wrap(tableName)}.${this.wrap(col)}`
            : this.wrap(col),
        );
        qb.groupBy(groupByColumns);
      }

      if (having && having.length > 0) {
        qb.having(having);
      }

      qb.orderBy(orderByMap);

      if (Array.isArray(limit)) {
        const [offset, count] = limit;
        const effectiveCount = (take && take > 0) ? take : (count === 0 ? 1 : count);
        if (this.isMySqlFamily()) qb.setDatabaseType("mysql");
        qb.limit([offset, effectiveCount]);
      } else if (skip !== undefined || (take !== undefined && !limit)) {
        // skip/take pagination → convert to limit tuple
        const offset = skip ?? 0;
        const count = (take ?? 0) || undefined;
        if (count) {
          if (this.isMySqlFamily()) qb.setDatabaseType("mysql");
          qb.limit([offset, count]);
        } else if (offset > 0 && this.isMySqlFamily()) {
          // MySQL requires a count with OFFSET — use a very large number
          qb.setDatabaseType("mysql");
          qb.limit([offset, 2147483647]);
        } else if (offset > 0) {
          qb.limit([offset, 2147483647]);
        }
      } else {
        if (limit) {
          qb.limit(limit as number);
        }
      }

      // Pessimistic lock suffix
      if (findOption.lock) {
        const lockSuffix = this.resolveLockSuffix(findOption.lock);
        qb.appendSql(raw(lockSuffix));
      }

      const resultQuery = qb.build();

      // Apply per-query or connection-level timeout
      const effectiveTimeout = findOption.timeout ?? this.defaultQueryTimeout;
      if (effectiveTimeout && effectiveTimeout > 0 && this.driver) {
        const timeoutSql = this.driver.setQueryTimeout(effectiveTimeout);
        await session.query(timeoutSql);
      }

      const queryStartTime = Date.now();
      this.beginTrackQuery();
      const queryResult = (await session.query<T>(
        resultQuery,
      )) as QueryResult;
      this.trackQuery(
        entity.name,
        resultQuery.text ?? String(resultQuery),
        Date.now() - queryStartTime,
      );

      const { results } = queryResult;
      if (!results || results.length === 0) {
        return undefined;
      }

      // SQLite: convert INTEGER 0/1 back to boolean
      if (this.isSqlite() && results.length > 0) {
        const boolColumns = metadata.columns
          .filter((c: any) => c.options?.type === "boolean")
          .map((c: any) => c.name as string);
        if (boolColumns.length > 0) {
          for (const row of results) {
            for (const col of boolColumns) {
              if (col in row) {
                row[col] = !!row[col];
              }
            }
          }
        }
      }

      const isEntityArray = results.length > 1;
      let entityResult: EntityResult<T>;

      // STI/TPC: polymorphic query on the root entity — instantiate the correct subclass via the discriminator
      if (
        (inheritanceStrategy === "SINGLE_TABLE" || isTPCPolymorphic) &&
        this.inheritanceResolver.isPolymorphicQuery(entity) &&
        !(hasEagerJoins && !isTPCPolymorphic)
      ) {
        const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
        const discColName = discCol?.name ?? "dtype";
        const discMap = this.inheritanceResolver.buildDiscriminatorMap(entity);
        if (discMap.size > 0) {
          entityResult = resultTransformer.toPolymorphicEntities(
            entity,
            queryResult,
            discMap,
            discColName,
          ) as EntityResult<T>;
        } else if (isEntityArray) {
          entityResult = resultTransformer.toEntities(entity, queryResult);
        } else {
          entityResult = resultTransformer.toEntity(entity, queryResult);
        }
      } else if (isTPTPolymorphic) {
        // TPT polymorphic: resolve child columns via their prefixes
        const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
        const discMap = this.inheritanceResolver.buildDiscriminatorMap(entity);
        if (discCol && discMap.size > 0) {
          const childPrefixMap = new Map<string, string>();
          const children = this.inheritanceResolver
            .getConcreteEntities(entity)
            .filter((c) => c !== entity);
          for (const child of children) {
            const childMeta = this.resolver.resolveEntityMetadata(child);
            const dv = this.inheritanceResolver.getDiscriminatorValue(child);
            if (childMeta && dv) {
              childPrefixMap.set(dv, childMeta.name!);
            }
          }
          entityResult = resultTransformer.toTPTPolymorphicEntities(
            entity,
            queryResult,
            discMap,
            discCol.name,
            childPrefixMap,
          ) as EntityResult<T>;
        } else if (isEntityArray) {
          entityResult = resultTransformer.toEntities(entity, queryResult);
        } else {
          entityResult = resultTransformer.toEntity(entity, queryResult);
        }
      } else if (hasEagerJoins && !isTPTChild) {
        entityResult = resultTransformer.transformNested(
          entity,
          queryResult,
        ) as EntityResult<T>;
      } else if (isTPTChild && eagerRelations.length > 0) {
        // TPT child + eager ManyToOne: deserialize the relation through transformNested
        entityResult = resultTransformer.transformNested(
          entity,
          queryResult,
        ) as EntityResult<T>;
      } else if (isEntityArray) {
        entityResult = resultTransformer.toEntities(entity, queryResult);
      } else {
        entityResult = resultTransformer.toEntity(entity, queryResult);
      }

      // Load OneToMany / ManyToMany / OneToOne(inverse) relations
      if (
        findOption.relations &&
        findOption.relations.length > 0 &&
        entityResult
      ) {
        await this.relationLoader.loadOneToManyRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
          session,
        );
        await this.relationLoader.loadManyToManyRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
          session,
        );
        await this.relationLoader.loadOneToOneRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
          session,
        );
      }

      // Inject a Proxy for each lazy ManyToOne relation
      const lazyRelations = manyToOneRelations.filter((rel) => {
        return rel.option?.lazy === true && rel.option?.eager !== true;
      });

      if (lazyRelations.length > 0 && entityResult) {
        const entities = Array.isArray(entityResult)
          ? entityResult
          : [entityResult];

        for (const rel of lazyRelations) {
          const joinColumn = rel.joinColumn ?? rel.columnName;
          const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;

          for (const item of entities) {
            const fkValue = (item as any)[joinColumn];
            if (fkValue === undefined || fkValue === null) continue;

            const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
            if (!relatedMetadata) continue;

            const relatedPk = relatedMetadata.columns.find(
              (col: any) => col.options?.primary,
            );
            if (!relatedPk) continue;

            const em = this;
            injectLazyProxy(item as any, rel.columnName, async () => {
              const result = await em.findOne(RelatedEntity, {
                where: { [this.propKey(relatedPk)]: fkValue } as any,
              });
              return result as any;
            });
          }
        }
      }

      // Notify subscribers of the afterLoad event
      if (entityResult) {
        const loadedEntities = Array.isArray(entityResult) ? entityResult : [entityResult];
        for (const loadedEntity of loadedEntities) {
          await this.notifySubscribers(entity, "afterLoad", loadedEntity);
        }
      }

      return entityResult;
    }, { existingSession, readNodeOverride: readNode, timeout: effectiveTimeout });
  }

  async findWithCursor<T>(
    entity: ClazzType<T>,
    option: CursorPaginationOption<T> = {},
  ): Promise<CursorPaginationResult<T>> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const pk = metadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );

    const orderByColumn = option.orderBy ?? (pk?.name as keyof T & string);
    if (!orderByColumn) {
      throw new InvalidQueryError(
        "Cursor pagination requires an orderBy column or a primary key.",
        "Add @PrimaryGeneratedColumn() to your entity or pass orderBy in FindOption.",
      );
    }

    // When orderBy is not provided, inspect the PK type and warn if it is non-numeric
    if (!option.orderBy && pk) {
      this.warnIfNonSortablePk(entity.name, pk);
    }

    const direction = option.direction ?? "ASC";
    const pageSize = normalizePageSize(option.take);

    let cursorValue: unknown = null;
    if (option.cursor) {
      cursorValue = decodeCursor(option.cursor);
      if (cursorValue === null) {
        throw new InvalidQueryError(
          "Invalid cursor value.",
          "Ensure the cursor string was returned from a previous findWithCursor() call.",
        );
      }
    }

    const where: any = { ...(option.where ?? {}) };
    const readNode = this.getReadNode(option.useMaster);

    return this.executeReadOnly(async (session) => {
      const resultTransformer = ResultTransformerFactory.create();

      const tableName = metadata.name!;
      const qb = RawQueryBuilderFactory.create();

      const selectMap = metadata.columns.map((column) =>
        this.wrap(column.name!),
      );

      const whereMap: Sql[] = resolveWhereClause(where, {
        wrapColumn: (n) => this.wrap(n),
        dialect: this._ctx.getDialect(),
        dialectExpression: createDialectExpression(this._ctx.getDialect()),
        propertyToColumn: this.buildPropertyToColumnMap(metadata),
      });

      const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
      if (deletedAtColumn) {
        whereMap.push(Conditions.isNull(this.wrap(deletedAtColumn)));
      }

      // Tenant scoping under the "tenant_column" strategy. Applied before the
      // cursor clause so the final WHERE is `tenant = ? AND cursor_col > ?`.
      if (!option.withoutTenantScope) {
        const tenantPredicate = this.buildTenantWhereClause(entity);
        if (tenantPredicate) {
          whereMap.push(tenantPredicate);
        }
      }

      if (cursorValue !== null) {
        if (direction === "ASC") {
          // Include NULL rows that haven't been seen yet (NULLs sort last in ASC)
          whereMap.push(Conditions.or([
            Conditions.gt(this.wrap(orderByColumn), cursorValue),
            Conditions.isNull(this.wrap(orderByColumn)),
          ]));
        } else {
          // Include NULL rows that haven't been seen yet (NULLs sort first in DESC)
          whereMap.push(Conditions.or([
            Conditions.lt(this.wrap(orderByColumn), cursorValue),
            Conditions.isNull(this.wrap(orderByColumn)),
          ]));
        }
      }

      qb.select(selectMap)
        .from(this.wrapTable(tableName))
        .where(whereMap)
        .orderBy([{ column: this.wrap(orderByColumn), direction }]);

      qb.limit(pageSize + 1);

      const resultQuery = qb.build();

      const queryResult = (await session.query<T>(
        resultQuery,
      )) as QueryResult;

      const { results } = queryResult;
      if (!results || results.length === 0) {
        return {
          data: [],
          hasNextPage: false,
          nextCursor: null,
          count: 0,
        };
      }

      const hasNextPage = results.length > pageSize;
      const pageResults = hasNextPage ? results.slice(0, pageSize) : results;

      const entities = resultTransformer.toEntities(entity, {
        results: pageResults,
        fields: queryResult.fields,
      });

      // Notify subscribers of the afterLoad event
      for (const loadedEntity of entities) {
        await this.notifySubscribers(entity, "afterLoad", loadedEntity);
      }

      let nextCursor: string | null = null;
      if (hasNextPage && pageResults.length > 0) {
        const lastItem = pageResults[pageResults.length - 1];
        const lastValue = lastItem[orderByColumn];
        nextCursor = encodeCursor(lastValue);
      }

      return {
        data: entities,
        hasNextPage,
        nextCursor,
        count: entities.length,
      };
    }, { readNodeOverride: readNode });
  }

  async findAndCount<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<[T[], number]> {
    const readNode = this.getReadNode(findOption.useMaster);
    return this.executeReadOnly(async (session) => {
      const entities = await this.findInternal<T>(entity, findOption, session);
      const totalCount = await this.aggregateHandler.aggregate<T>(entity, "COUNT", "*", findOption.where, session);

      return [entities as unknown as T[], totalCount];
    }, { readNodeOverride: readNode, timeout: findOption.timeout });
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
    const page = normalizePage(option.page);
    const pageSize = normalizePageSize(option.pageSize);
    const offset = (page - 1) * pageSize;

    const [rawData, total] = await this.findAndCount<T>(entity, {
      where: option.where,
      orderBy: option.orderBy,
      select: option.select,
      relations: option.relations,
      withDeleted: option.withDeleted,
      timeout: option.timeout,
      useMaster: option.useMaster,
      groupBy: option.groupBy,
      having: option.having,
      limit: [offset, pageSize],
    });

    const data = (rawData ?? []) as T[];
    const totalPages = Math.ceil(total / pageSize);

    return {
      data,
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    };
  }

  // ── CRUD: Write ────────────────────────────────────────────

  async save<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<InstanceType<ClazzType<T>>> {
    return this.saveInternal(entity, item);
  }

  private async saveInternal<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
    existingSession?: TransactionSessionManager,
  ): Promise<InstanceType<ClazzType<T>>> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    // Validation
    EntityValidator.validate(entity, item);

    // Cascade: save the parent entity of any ManyToOne relation first
    await this.cascadeHandler.cascadeSaveManyToOne(entity, item);

    return this.executeInTransaction(async (session) => {
      const pkColumns = metadata.columns.filter(
        (column: ColumnMetadata) => column.options?.primary,
      );
      const pk = pkColumns[0];

      const hasAutoIncrementPk = pkColumns.some(
        (col: ColumnMetadata) => col.options?.autoIncrement,
      );
      const hasGeneratedPk = pkColumns.some(
        (col: ColumnMetadata) =>
          col.options?.autoIncrement ||
          col.options?.generationStrategy === "uuid" ||
          col.options?.generationStrategy === "uuid-v7",
      );
      const primaryKeyValue = pk ? (item as any)[this.propKey(pk)] : undefined;

      const isInsert = hasGeneratedPk
        ? !primaryKeyValue
        : true;

      const buildPkWhere = (pkValues?: Record<string, any>) => {
        return pkColumns.map((col: ColumnMetadata) => {
          const value = pkValues
            ? pkValues[col.name!]
            : (item as any)[this.propKey(col)];
          return sql`${raw(this.wrap(col.name!))} = ${value}`;
        });
      };

      const buildPkFindWhere = (pkValues?: Record<string, any>) => {
        const where: any = {};
        for (const col of pkColumns) {
          where[this.propKey(col)] = pkValues
            ? pkValues[col.name!]
            : (item as any)[this.propKey(col)];
        }
        return where;
      };

      if (isInsert) {
        await this.cascadeHandler.runHooks(entity, item, "beforeInsert");
        await this.eventEmitter.emit("beforeInsert", { entity, data: item });
        await this.notifySubscribers(entity, "beforeInsert", {
          entity: item,
          manager: this,
        } as InsertEvent<T>);

        this.applyTenantColumnOnInsert(entity, item);

        const computedCols = this.getComputedColumnNames(entity);
        const insertableColumns = metadata.columns.filter(
          (column: ColumnMetadata) => {
            if (computedCols.has(column.name!)) return false;
            const isAutoIncrement = column.options?.autoIncrement;
            const value = (item as any)[this.propKey(column)];
            if (isAutoIncrement && (value === null || value === undefined)) {
              return false;
            }
            return true;
          },
        );

        const columns = insertableColumns.map((column) => {
          return raw(this.wrap(column.name!));
        });

        const values = insertableColumns.map((column: ColumnMetadata) => {
          const rawValue = (item as any)[this.propKey(column)];
          return this.applyWriteTransform(column, rawValue);
        });

        // Auto-inject @CreateTimestamp / @UpdateTimestamp values (on INSERT)
        const now = new Date();
        const nowStr = formatDateTimeForSQL(now);
        const createTsCol = this.resolver.getCreateTimestampColumn(entity);
        if (createTsCol) {
          const idx = insertableColumns.findIndex(
            (col: ColumnMetadata) => col.name === createTsCol,
          );
          if (idx >= 0) {
            const existing = (item as any)[createTsCol];
            values[idx] = existing instanceof Date ? formatDateTimeForSQL(existing) : (existing ?? nowStr);
          }
        }
        const updateTsCol = this.resolver.getUpdateTimestampColumn(entity);
        if (updateTsCol) {
          const idx = insertableColumns.findIndex(
            (col: ColumnMetadata) => col.name === updateTsCol,
          );
          if (idx >= 0) {
            const existing = (item as any)[updateTsCol];
            values[idx] = existing instanceof Date ? formatDateTimeForSQL(existing) : (existing ?? nowStr);
          }
        }

        // Auto-initialize the @Version column
        const versionCol = this.resolver.getVersionColumn(entity);
        if (versionCol) {
          const versionIdx = insertableColumns.findIndex(
            (col: ColumnMetadata) => col.name === versionCol,
          );
          if (versionIdx >= 0) {
            values[versionIdx] = 1;
          }
        }

        // Auto-generate UUID PKs on the application side
        for (let i = 0; i < insertableColumns.length; i++) {
          const col = insertableColumns[i];
          const strategy = col.options?.generationStrategy;
          if (!strategy || strategy === "increment") continue;
          if (values[i] !== null && values[i] !== undefined) continue;

          // PostgreSQL uuid strategy: DB generates via DEFAULT gen_random_uuid()
          if (strategy === "uuid" && this.isPostgres()) {
            // exclude column from INSERT so DEFAULT kicks in
            columns.splice(i, 1);
            values.splice(i, 1);
            insertableColumns.splice(i, 1);
            i--;
            continue;
          }

          if (strategy === "uuid") {
            values[i] = randomUUID();
            (item as any)[this.propKey(col)] = values[i];
          } else if (strategy === "uuid-v7") {
            values[i] = generateUUIDv7();
            (item as any)[this.propKey(col)] = values[i];
          }
        }

        // STI/TPT: add or set the discriminator column value on INSERT
        const saveInheritanceStrategy = this.inheritanceResolver.getStrategy(entity);
        if (saveInheritanceStrategy === "SINGLE_TABLE" || saveInheritanceStrategy === "JOINED") {
          const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
          const discVal = this.inheritanceResolver.getDiscriminatorValue(entity);
          if (discCol && discVal) {
            const existingDiscIdx = insertableColumns.findIndex(
              (col: ColumnMetadata) => col.name === discCol.name,
            );
            if (existingDiscIdx >= 0) {
              values[existingDiscIdx] = discVal;
            } else {
              columns.push(raw(this.wrap(discCol.name)));
              values.push(discVal);
            }
          }
        }

        // Extract FK column values for ManyToOne relations
        const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
        for (const rel of manyToOneRelations) {
          if (!rel.joinColumn) continue;
          const relatedValue = (item as any)[rel.columnName];
          const idPropValue = (item as any)[`${rel.columnName}Id`];

          const existingIdx = insertableColumns.findIndex(
            (col: ColumnMetadata) => col.name === rel.joinColumn,
          );

          let fkValue: any = undefined;

          if (relatedValue === null) {
            fkValue = null;
          } else if (relatedValue && typeof relatedValue === "object") {
            const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
            const relatedMeta = this.resolver.resolveEntityMetadata(RelatedEntity);
            if (relatedMeta) {
              const relatedPk = relatedMeta.columns.find(
                (col: any) => col.options?.primary,
              );
              if (relatedPk) {
                fkValue = relatedValue[this.propKey(relatedPk)] ?? undefined;
              }
            }
          } else if (idPropValue != null) {
            fkValue = idPropValue;
          }

          if (fkValue !== undefined) {
            if (existingIdx >= 0) {
              values[existingIdx] = fkValue;
            } else {
              columns.push(raw(this.wrap(rel.joinColumn)));
              values.push(fkValue);
            }
          }
        }

        // PostgreSQL (all versions), MariaDB 10.5+: INSERT ... RETURNING *
        const useReturning =
          (typeof this.driver?.supportsInsertReturning === "function" && this.driver.supportsInsertReturning()) ||
          (typeof this.driver?.supportsReturning === "function" && this.driver.supportsReturning());

        // TPT child: INSERT into parent first → INSERT into child (sharing the same PK)
        if (saveInheritanceStrategy === "JOINED" && this.inheritanceResolver.isChildEntity(entity)) {
          const root = this.inheritanceResolver.getRoot(entity)!;
          const rootMeta = this.resolver.resolveEntityMetadata(root);
          if (rootMeta) {
            const rootColNames = new Set(
              rootMeta.columns.map((c: any) => c.name),
            );
            const pkColNames = new Set(
              pkColumns.map((col: ColumnMetadata) => col.name!),
            );

            // Split columns/values into parent and child buckets
            const parentCols: Sql[] = [];
            const parentVals: any[] = [];
            const childCols: Sql[] = [];
            const childVals: any[] = [];

            for (let i = 0; i < insertableColumns.length; i++) {
              const col = insertableColumns[i];
              const isPk = pkColNames.has(col.name!);
              const isRoot = rootColNames.has(col.name!);

              if (isPk || isRoot) {
                parentCols.push(columns[i]);
                parentVals.push(values[i]);
              }
              if (isPk || !isRoot) {
                childCols.push(columns[i]);
                childVals.push(values[i]);
              }
            }

            // Extra appended columns (e.g. discriminator, FK) live outside the insertableColumns range
            for (let i = insertableColumns.length; i < columns.length; i++) {
              parentCols.push(columns[i]);
              parentVals.push(values[i]);
            }

            // 1. INSERT into the parent table
            const parentTableName = rootMeta.name!;
            const parentReturningSql = useReturning ? raw(` RETURNING *`) : raw("");
            const parentInsertSql = sql`INSERT INTO ${raw(this.wrapTable(parentTableName))}
              (${join(parentCols, ", ")})
              VALUES (${join(parentVals, ", ")})${parentReturningSql}`;

            const parentResult = (await session.query<T>(parentInsertSql)) as {
              results: any;
              fields: any;
            };

            // Obtain the generated PK value
            let generatedPkValue: any;
            if (useReturning && parentResult?.results?.length > 0) {
              generatedPkValue = parentResult.results[0][pk.name!];
            } else if (this.isMySqlFamily()) {
              generatedPkValue = parentResult?.results?.insertId;
            } else if (this.isSqlite()) {
              generatedPkValue = Number(
                (parentResult?.results ?? parentResult)?.lastInsertRowid,
              );
            }

            // 2. INSERT into the child table (reusing the same PK)
            if (generatedPkValue != null) {
              // Find the PK position via its insertableColumns index mapping
              let pkFoundInChild = false;
              for (let ci = 0, ii = 0; ii < insertableColumns.length; ii++) {
                const col = insertableColumns[ii];
                const isPk = pkColNames.has(col.name!);
                const isRoot = rootColNames.has(col.name!);
                if (isPk || !isRoot) {
                  // This column exists in childCols
                  if (isPk) {
                    childVals[ci] = generatedPkValue;
                    pkFoundInChild = true;
                  }
                  ci++;
                }
              }
              // If the PK is missing from childCols, add it
              if (!pkFoundInChild) {
                childCols.unshift(raw(this.wrap(pk.name!)));
                childVals.unshift(generatedPkValue);
              }
            }

            if (childCols.length > 0) {
              const childInsertSql = sql`INSERT INTO ${raw(this.wrapTable(metadata.name!))}
                (${join(childCols, ", ")})
                VALUES (${join(childVals, ", ")})`;
              await session.query<T>(childInsertSql);
            }

            // Read the resulting row back
            const pkVal = generatedPkValue ?? primaryKeyValue;
            (item as any)[this.propKey(pk)] = pkVal;
            const result = await this.findOneInternal(
              entity,
              { where: { [this.propKey(pk)]: pkVal } as any },
              session,
            );

            await this.cascadeHandler.cascadeSaveOneToMany(
              entity,
              item,
              pkVal,
              session,
            );
            await this.cascadeHandler.runHooks(entity, item, "afterInsert");
            await this.eventEmitter.emit("afterInsert", {
              entity,
              data: item,
            });
            await this.notifySubscribers(entity, "afterInsert", {
              entity: item,
              manager: this,
            } as InsertEvent<T>);
            return result as T;
          }
        }

        const returningSql = useReturning
          ? raw(` RETURNING *`)
          : raw("");

        const insertSql = sql`
                        INSERT INTO ${raw(this.wrapTable(metadata.name!))}
                        (${join(columns, ", ")})
                        VALUES (${join(values, ", ")})${returningSql}
                    `;
        const saveQueryStart = Date.now();
        this.beginTrackQuery();
        const queryResult = (await session.query<T>(insertSql)) as {
          results: any;
          fields: any;
        };
        this.trackQuery(
          entity.name,
          insertSql.text ?? String(insertSql),
          Date.now() - saveQueryStart,
        );

        // MariaDB 10.5+ returns rows via RETURNING; fall through to the generic
        // `useReturning && results.length > 0` branch below instead of the insertId path.
        const mariaDbReturned =
          useReturning &&
          this.isMySqlFamily() &&
          Array.isArray(queryResult?.results) &&
          queryResult.results.length > 0;

        if (this.isMySqlFamily() && !mariaDbReturned) {
          const findWhere = hasAutoIncrementPk
            ? { [this.propKey(pk)]: queryResult?.results?.insertId }
            : buildPkFindWhere();
          const result = await this.findOneInternal(entity, {
            where: findWhere,
          } as any, session);

          const cascadeId = hasAutoIncrementPk
            ? queryResult?.results?.insertId
            : primaryKeyValue;
          await this.cascadeHandler.cascadeSaveOneToMany(entity, item, cascadeId, session);
          await this.cascadeHandler.runHooks(entity, item, "afterInsert");
          await this.eventEmitter.emit("afterInsert", { entity, data: item });
          await this.notifySubscribers(entity, "afterInsert", {
            entity: item,
            manager: this,
          } as InsertEvent<T>);
          return result as T;
        }

        // Drivers that support RETURNING *: deserialize directly from the returned row (when there are no eager relations)
        if (useReturning && queryResult?.results?.length > 0) {
          const returnedRow = queryResult.results[0];
          const cascadeId = returnedRow[pk.name!];
          await this.cascadeHandler.cascadeSaveOneToMany(entity, item, cascadeId, session);
          await this.cascadeHandler.runHooks(entity, item, "afterInsert");
          await this.eventEmitter.emit("afterInsert", { entity, data: item });
          await this.notifySubscribers(entity, "afterInsert", {
            entity: item,
            manager: this,
          } as InsertEvent<T>);

          const hasEagerRelations = this.hasEagerRelations(entity);
          if (!hasEagerRelations) {
            return deserializeEntity(entity, returnedRow) as T;
          }
          const findWhere = buildPkFindWhere(returnedRow);
          const result = await this.findOneInternal(entity, {
            where: findWhere,
          } as any, session);
          return result as T;
        }

        // SQLite: look up the inserted entity via lastInsertRowid
        if (this.isSqlite()) {
          const sqliteRunResult = queryResult?.results ?? queryResult;
          const findWhere = hasAutoIncrementPk
            ? { [this.propKey(pk)]: Number(sqliteRunResult?.lastInsertRowid) }
            : buildPkFindWhere();
          const result = await this.findOneInternal(entity, {
            where: findWhere,
          } as any, session);

          const cascadeId = hasAutoIncrementPk
            ? Number(sqliteRunResult?.lastInsertRowid)
            : primaryKeyValue;
          await this.cascadeHandler.cascadeSaveOneToMany(entity, item, cascadeId, session);
          await this.cascadeHandler.runHooks(entity, item, "afterInsert");
          await this.eventEmitter.emit("afterInsert", { entity, data: item });
          await this.notifySubscribers(entity, "afterInsert", {
            entity: item,
            manager: this,
          } as InsertEvent<T>);
          return result as T;
        }

        await this.cascadeHandler.runHooks(entity, item, "afterInsert");
        await this.eventEmitter.emit("afterInsert", { entity, data: item });
        await this.notifySubscribers(entity, "afterInsert", {
          entity: item,
          manager: this,
        } as InsertEvent<T>);
        return queryResult as T;
      }

      // UPDATE path
      //
      // Pre-read the database state when any subscriber wants it (for diff
      // audits, change-detection cache invalidation, etc.). Skipping the
      // SELECT when no subscriber listens keeps the cost of save() unchanged
      // for entities that don't opt in.
      const wantsDatabaseEntity =
        this.hasSubscriberFor(entity, "beforeUpdate") ||
        this.hasSubscriberFor(entity, "afterUpdate");
      const databaseEntity: T | null = wantsDatabaseEntity
        ? ((await this.findOneInternal(
            entity,
            { where: buildPkFindWhere() } as any,
            session,
          )) as T | null)
        : null;

      await this.cascadeHandler.runHooks(entity, item, "beforeUpdate");
      await this.eventEmitter.emit("beforeUpdate", { entity, data: item });
      await this.notifySubscribers(entity, "beforeUpdate", {
        entity: item,
        databaseEntity,
        manager: this,
      } as UpdateEvent<T>);

      const versionColName = this.resolver.getVersionColumn(entity);
      const pkColumnNames = new Set(
        pkColumns.map((col: ColumnMetadata) => col.name!),
      );
      const computedColsForUpdate = this.getComputedColumnNames(entity);
      // STI: the discriminator column is excluded from UPDATE
      const updateDiscCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
      const updatableColumns = metadata.columns.filter(
        (column: ColumnMetadata) => {
          if (computedColsForUpdate.has(column.name!)) return false;
          if (pkColumnNames.has(column.name!)) return false;
          if (versionColName && column.name === versionColName) return false;
          if (updateDiscCol && column.name === updateDiscCol.name) return false;
          return (item as any)[this.propKey(column)] !== undefined;
        },
      );
      const updateMap = updatableColumns.map((column: ColumnMetadata) => {
        let value = (item as any)[this.propKey(column)];
        value = this.applyWriteTransform(column, value);
        return sql`${raw(this.wrap(column.name!))} = ${value}`;
      });

      // Auto-inject @UpdateTimestamp
      const updateTsColName = this.resolver.getUpdateTimestampColumn(entity);
      if (updateTsColName) {
        const existingIdx = updatableColumns.findIndex(
          (col: ColumnMetadata) => col.name === updateTsColName,
        );
        const updateNow = formatDateTimeForSQL(new Date());
        if (existingIdx >= 0) {
          updateMap[existingIdx] =
            sql`${raw(this.wrap(updateTsColName))} = ${updateNow}`;
        } else {
          updateMap.push(
            sql`${raw(this.wrap(updateTsColName))} = ${updateNow}`,
          );
        }
      }

      const updatedColumnNames = new Set(
        updatableColumns.map((col: ColumnMetadata) => col.name!),
      );

      // Add the ManyToOne FK column values to the UPDATE SET clause
      const updateManyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
      for (const rel of updateManyToOneRelations) {
        if (!rel.joinColumn) continue;
        const relatedValue = (item as any)[rel.columnName];

        if (relatedValue === undefined) continue;

        const alreadyInSet = updatedColumnNames.has(rel.joinColumn);

        if (relatedValue === null) {
          if (alreadyInSet) {
            const existingIdx = updatableColumns.findIndex(
              (col: ColumnMetadata) => col.name === rel.joinColumn,
            );
            updateMap[existingIdx] =
              sql`${raw(this.wrap(rel.joinColumn))} = ${null}`;
          } else {
            updateMap.push(sql`${raw(this.wrap(rel.joinColumn))} = ${null}`);
            updatedColumnNames.add(rel.joinColumn);
          }
        } else if (typeof relatedValue === "object") {
          const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
          const relatedMeta = this.resolver.resolveEntityMetadata(RelatedEntity);
          if (relatedMeta) {
            const relatedPk = relatedMeta.columns.find(
              (col: any) => col.options?.primary,
            );
            if (relatedPk) {
              const fkValue = relatedValue[this.propKey(relatedPk)];
              if (fkValue !== undefined && fkValue !== null) {
                if (alreadyInSet) {
                  const existingIdx = updatableColumns.findIndex(
                    (col: ColumnMetadata) => col.name === rel.joinColumn,
                  );
                  updateMap[existingIdx] =
                    sql`${raw(this.wrap(rel.joinColumn))} = ${fkValue}`;
                } else {
                  updateMap.push(
                    sql`${raw(this.wrap(rel.joinColumn))} = ${fkValue}`,
                  );
                  updatedColumnNames.add(rel.joinColumn);
                }
              }
            }
          }
        }
      }

      const pkWhereClauses = buildPkWhere();

      // @Version: Optimistic Locking
      const currentVersion = versionColName
        ? (item as any)[versionColName]
        : undefined;
      if (versionColName) {
        updateMap.push(
          sql`${raw(this.wrap(versionColName))} = ${raw(this.wrap(versionColName))} + 1`,
        );
        if (currentVersion !== undefined && currentVersion !== null) {
          pkWhereClauses.push(
            sql`${raw(this.wrap(versionColName))} = ${currentVersion}`,
          );
        }
      }

      const useReturningForUpdate = typeof this.driver?.supportsReturning === "function" && this.driver.supportsReturning();
      let updateReturnedRow: any = null;

      // TPT child: UPDATE the parent and child tables separately
      const updateInheritanceStrategy = this.inheritanceResolver.getStrategy(entity);
      if (
        updateInheritanceStrategy === "JOINED" &&
        this.inheritanceResolver.isChildEntity(entity) &&
        updateMap.length > 0
      ) {
        const root = this.inheritanceResolver.getRoot(entity)!;
        const rootMeta = this.resolver.resolveEntityMetadata(root);
        if (rootMeta) {
          const rootColNames = new Set(
            rootMeta.columns.map((c: any) => c.name),
          );

          const parentUpdateMap: Sql[] = [];
          const childUpdateMap: Sql[] = [];

          for (let i = 0; i < updatableColumns.length; i++) {
            if (rootColNames.has(updatableColumns[i].name!)) {
              parentUpdateMap.push(updateMap[i]);
            } else {
              childUpdateMap.push(updateMap[i]);
            }
          }

          // Extra items (e.g. @UpdateTimestamp, @Version) belong on the parent table
          for (let i = updatableColumns.length; i < updateMap.length; i++) {
            parentUpdateMap.push(updateMap[i]);
          }

          if (parentUpdateMap.length > 0) {
            const parentUpdateSql = sql`UPDATE ${raw(this.wrapTable(rootMeta.name!))}
              SET ${join(parentUpdateMap, ", ")}
              WHERE ${join(pkWhereClauses, " AND ")}`;
            await session.query<T>(parentUpdateSql);
          }

          if (childUpdateMap.length > 0) {
            const childUpdateSql = sql`UPDATE ${raw(this.wrapTable(metadata.name!))}
              SET ${join(childUpdateMap, ", ")}
              WHERE ${join(pkWhereClauses, " AND ")}`;
            await session.query<T>(childUpdateSql);
          }

          await this.cascadeHandler.cascadeSaveOneToMany(
            entity,
            item,
            primaryKeyValue,
            session,
          );
          await this.cascadeHandler.runHooks(entity, item, "afterUpdate");
          await this.eventEmitter.emit("afterUpdate", {
            entity,
            data: item,
          });
          await this.notifySubscribers(entity, "afterUpdate", {
            entity: item,
            databaseEntity,
            manager: this,
          } as UpdateEvent<T>);

          const tptResult = await this.findOneInternal(
            entity,
            { where: buildPkFindWhere() } as any,
            session,
          );
          return tptResult as T;
        }
      }

      if (updateMap.length > 0) {
        const updateReturningSql = useReturningForUpdate
          ? raw(` RETURNING *`)
          : raw("");
        const updateSql = sql`
            UPDATE ${raw(this.wrapTable(metadata.name!))}
            SET ${join(updateMap, ", ")}
            WHERE ${join(pkWhereClauses, " AND ")}${updateReturningSql}
                  `;
        const updateStart = Date.now();
        this.beginTrackQuery();
        const updateResult = (await session.query<T>(updateSql)) as {
          results: any;
          fields: any;
          rowCount?: number;
        };
        this.trackQuery(
          entity.name,
          updateSql.text ?? String(updateSql),
          Date.now() - updateStart,
        );

        if (versionColName && currentVersion !== undefined && currentVersion !== null) {
          let affected = 0;
          if (this.isMySqlFamily()) {
            affected = updateResult?.results?.affectedRows ?? 0;
          } else {
            affected = updateResult?.rowCount ?? 0;
          }
          if (affected === 0) {
            throw new OptimisticLockError(entity.name, currentVersion);
          }
        }

        if (useReturningForUpdate && updateResult?.results?.length > 0) {
          updateReturnedRow = updateResult.results[0];
        }
      }

      await this.cascadeHandler.cascadeSaveOneToMany(entity, item, primaryKeyValue, session);

      await this.cascadeHandler.runHooks(entity, item, "afterUpdate");
      await this.eventEmitter.emit("afterUpdate", { entity, data: item });
      await this.notifySubscribers(entity, "afterUpdate", {
        entity: item,
        databaseEntity,
        manager: this,
      } as UpdateEvent<T>);

      if (updateReturnedRow && !this.hasEagerRelations(entity)) {
        return deserializeEntity(entity, updateReturnedRow) as T;
      }

      const result = await this.findOneInternal(entity, {
        where: buildPkFindWhere(),
      } as any, session);

      return result as T;
    }, existingSession);
  }

  async saveMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<InstanceType<ClazzType<T>>[]> {
    if (items.length === 0) {
      return [];
    }

    // #214: attempt the batch INSERT optimization
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (metadata) {
      const pkColumns = metadata.columns.filter(
        (col: ColumnMetadata) => col.options?.primary,
      );
      const pk = pkColumns[0];
      const hasGeneratedPk = pkColumns.some(
        (col: ColumnMetadata) =>
          col.options?.autoIncrement ||
          col.options?.generationStrategy === "uuid" ||
          col.options?.generationStrategy === "uuid-v7",
      );
      const canBatchInsert =
        hasGeneratedPk &&
        pkColumns.length === 1 &&
        items.every((item) => {
          const pkValue = pk ? (item as any)[this.propKey(pk)] : undefined;
          return pkValue === null || pkValue === undefined;
        });

      if (canBatchInsert) {
        // Validation + ManyToOne cascade (before the transaction)
        for (const item of items) {
          EntityValidator.validate(entity, item);
        }
        for (const item of items) {
          await this.cascadeHandler.cascadeSaveManyToOne(entity, item);
        }

        return this.executeInTransaction(async (session) => {
          return this.saveManyBatchInsert(entity, pk, items, session);
        });
      }
    }

    // Fallback: sequential saves
    return this.executeInTransaction(async (session) => {
      const results: InstanceType<ClazzType<T>>[] = [];
      for (const item of items) {
        const saved = await this.saveInternal(entity, item, session);
        results.push(saved);
      }
      return results;
    });
  }

  /**
   * #214: Batch INSERT + bulk re-read.
   * N × (INSERT+SELECT) → 1 INSERT + 1 SELECT (or PG RETURNING).
   */
  private async saveManyBatchInsert<T>(
    entity: ClazzType<T>,
    pk: ColumnMetadata,
    items: Partial<T>[],
    session: TransactionSessionManager,
  ): Promise<InstanceType<ClazzType<T>>[]> {
    const metadata = this.resolver.resolveEntityMetadata(entity)!;
    const hasAutoIncrementPk = pk.options?.autoIncrement === true;

    // beforeInsert hooks/events
    for (const item of items) {
      await this.cascadeHandler.runHooks(entity, item, "beforeInsert");
      await this.eventEmitter.emit("beforeInsert", { entity, data: item });
      await this.notifySubscribers(entity, "beforeInsert", {
        entity: item,
        manager: this,
      } as InsertEvent<T>);
    }

    // Apply tenant column after user hooks (hooks may want to inspect state)
    if (this.tenantColumnConfig) {
      for (const item of items) {
        this.applyTenantColumnOnInsert(entity, item);
      }
    }

    // Prepare columns
    const computedCols = this.getComputedColumnNames(entity);
    const createTsCol = this.resolver.getCreateTimestampColumn(entity);
    const updateTsCol = this.resolver.getUpdateTimestampColumn(entity);
    const versionCol = this.resolver.getVersionColumn(entity);
    const now = new Date();

    const insertableColumns = metadata.columns.filter(
      (col) => {
        if (computedCols.has(col.name!)) return false;
        if (col.options?.autoIncrement) return false;
        // PostgreSQL uuid: rely on the DB DEFAULT
        if (col.options?.generationStrategy === "uuid" && this.isPostgres()) return false;
        return true;
      },
    );

    // Pre-process items: UUID, timestamp, version
    for (const item of items) {
      for (const col of insertableColumns) {
        const strategy = col.options?.generationStrategy;
        if (!strategy || strategy === "increment") continue;
        if ((item as any)[this.propKey(col)] != null) continue;
        if (strategy === "uuid") {
          (item as any)[this.propKey(col)] = randomUUID();
        } else if (strategy === "uuid-v7") {
          (item as any)[this.propKey(col)] = generateUUIDv7();
        }
      }
      if (createTsCol) {
        const col = insertableColumns.find((c) => c.name === createTsCol);
        if (col && (item as any)[this.propKey(col)] == null) {
          (item as any)[this.propKey(col)] = now;
        }
      }
      if (updateTsCol) {
        const col = insertableColumns.find((c) => c.name === updateTsCol);
        if (col && (item as any)[this.propKey(col)] == null) {
          (item as any)[this.propKey(col)] = now;
        }
      }
      if (versionCol && (item as any)[versionCol] == null) {
        (item as any)[versionCol] = 1;
      }
    }

    // Column list + FK columns
    const columns = insertableColumns.map((col) =>
      raw(this.wrap(col.name!)),
    );
    const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
    const fkColumns: { joinColumn: string; propertyName: string; relMeta: any }[] = [];
    for (const rel of manyToOneRelations) {
      if (!rel.joinColumn) continue;
      if (insertableColumns.some((col) => col.name === rel.joinColumn)) continue;
      columns.push(raw(this.wrap(rel.joinColumn)));
      fkColumns.push({ joinColumn: rel.joinColumn, propertyName: rel.columnName, relMeta: rel });
    }

    // Build the VALUES rows
    const valueRows = items.map((item) => {
      const rowValues = insertableColumns.map((col) => {
        const rawValue = (item as any)[this.propKey(col)];
        const transformed = this.applyWriteTransform(col, rawValue);
        if (transformed instanceof Date) return formatDateTimeForSQL(transformed);
        return transformed;
      });
      for (const fk of fkColumns) {
        const relatedValue = (item as any)[fk.propertyName];
        const idPropValue = (item as any)[`${fk.propertyName}Id`];
        if (relatedValue === null) {
          rowValues.push(null);
        } else if (relatedValue && typeof relatedValue === "object") {
          const RelatedEntity = fk.relMeta.getMappingEntity() as ClazzType<any>;
          const relatedMeta = this.resolver.resolveEntityMetadata(RelatedEntity);
          const relatedPk = relatedMeta?.columns.find((c: any) => c.options?.primary);
          rowValues.push(relatedPk ? relatedValue[this.propKey(relatedPk)] ?? null : null);
        } else if (idPropValue != null) {
          rowValues.push(idPropValue);
        } else {
          rowValues.push(null);
        }
      }
      return sql`(${join(rowValues, ", ")})`;
    });

    // INSERT SQL (PostgreSQL all versions, MariaDB 10.5+: RETURNING *)
    const useReturning =
      (typeof this.driver?.supportsInsertReturning === "function" && this.driver.supportsInsertReturning()) ||
      (typeof this.driver?.supportsReturning === "function" && this.driver.supportsReturning());
    const returningSql = useReturning ? raw(` RETURNING *`) : raw("");
    const insertSql = sql`INSERT INTO ${raw(this.wrapTable(metadata.name!))} (${join(columns, ", ")}) VALUES ${join(valueRows, ", ")}${returningSql}`;

    this.beginTrackQuery();
    const queryStart = Date.now();
    const queryResult = (await session.query(insertSql)) as {
      results: any; fields: any; rowCount?: number;
    };
    this.trackQuery(entity.name, insertSql.text ?? String(insertSql), Date.now() - queryStart);

    // Collect results
    let results: InstanceType<ClazzType<T>>[];

    if (useReturning && queryResult?.results?.length > 0 && !this.hasEagerRelations(entity)) {
      // PostgreSQL RETURNING: deserialize directly without a re-read
      results = queryResult.results.map(
        (row: any) => deserializeEntity(entity, row) as InstanceType<ClazzType<T>>,
      );
    } else {
      // Compute PK values → bulk SELECT WHERE pk IN (...)
      let pkValues: any[];
      if (useReturning && queryResult?.results?.length > 0) {
        pkValues = queryResult.results.map((row: any) => row[pk.name!]);
      } else if (this.isMySqlFamily() && hasAutoIncrementPk) {
        const firstId = queryResult?.results?.insertId;
        pkValues = items.map((_, i) => firstId + i);
      } else if (this.isSqlite() && hasAutoIncrementPk) {
        const sqliteRes = queryResult?.results ?? queryResult;
        const lastId = Number(sqliteRes?.lastInsertRowid);
        pkValues = items.map((_, i) => lastId - items.length + 1 + i);
      } else {
        // UUID — use client-generated PK values
        pkValues = items.map((item) => (item as any)[this.propKey(pk)]);
      }

      const found = await this.findInternal(
        entity,
        { where: { [this.propKey(pk)]: pkValues } as any },
        session,
      );
      const resultArray: any[] = Array.isArray(found) ? found : found ? [found] : [];
      const resultMap = new Map<any, InstanceType<ClazzType<T>>>();
      for (const row of resultArray) {
        resultMap.set((row as any)[this.propKey(pk)], row as InstanceType<ClazzType<T>>);
      }
      results = pkValues.map((id) => resultMap.get(id)!).filter(Boolean);
    }

    // OneToMany cascade per item
    for (let i = 0; i < items.length; i++) {
      const cascadeId = results[i] ? (results[i] as any)[this.propKey(pk)] : undefined;
      if (cascadeId !== undefined) {
        await this.cascadeHandler.cascadeSaveOneToMany(entity, items[i], cascadeId, session);
      }
    }

    // afterInsert hooks/events
    for (const item of items) {
      await this.cascadeHandler.runHooks(entity, item, "afterInsert");
      await this.eventEmitter.emit("afterInsert", { entity, data: item });
      await this.notifySubscribers(entity, "afterInsert", {
        entity: item,
        manager: this,
      } as InsertEvent<T>);
    }

    return results;
  }

  async insertMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<{ affected: number }> {
    if (items.length === 0) {
      return { affected: 0 };
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    return this.executeInTransaction(async (session) => {
      if (this.tenantColumnConfig) {
        for (const item of items) {
          this.applyTenantColumnOnInsert(entity, item);
        }
      }

      const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
      const timestampTypes = new Set(["datetime", "timestamp", "date"]);
      const timestampColumns = metadata.columns.filter(
        (col: ColumnMetadata) =>
          col.options?.type &&
          timestampTypes.has(col.options.type) &&
          col.name !== deletedAtColumn,
      );
      if (timestampColumns.length > 0) {
        const now = new Date();
        for (const item of items) {
          for (const col of timestampColumns) {
            if ((item as any)[this.propKey(col)] == null) {
              (item as any)[this.propKey(col)] = now;
            }
          }
        }
      }

      const versionCol = this.resolver.getVersionColumn(entity);
      if (versionCol) {
        for (const item of items) {
          if ((item as any)[versionCol] == null) {
            (item as any)[versionCol] = 1;
          }
        }
      }

      const computedColsMany = this.getComputedColumnNames(entity);
      const insertableColumns = metadata.columns.filter(
        (column: ColumnMetadata) => {
          if (computedColsMany.has(column.name!)) return false;
          const isAutoIncrement = column.options?.autoIncrement;
          if (!isAutoIncrement) return true;
          return items.every(
            (item) =>
              (item as any)[this.propKey(column)] !== null &&
              (item as any)[this.propKey(column)] !== undefined,
          );
        },
      );

      const columns = insertableColumns.map((column) =>
        raw(this.wrap(column.name!)),
      );

      const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
      const fkColumns: { joinColumn: string; propertyName: string; relMeta: any }[] = [];
      for (const rel of manyToOneRelations) {
        if (!rel.joinColumn) continue;
        const alreadyIncluded = insertableColumns.some(
          (col: ColumnMetadata) => col.name === rel.joinColumn,
        );
        if (!alreadyIncluded) {
          columns.push(raw(this.wrap(rel.joinColumn)));
          fkColumns.push({
            joinColumn: rel.joinColumn,
            propertyName: rel.columnName,
            relMeta: rel,
          });
        }
      }

      const valueRows = items.map((item) => {
        const rowValues = insertableColumns.map(
          (column: ColumnMetadata) => (item as any)[this.propKey(column)],
        );
        for (const fk of fkColumns) {
          const relatedValue = (item as any)[fk.propertyName];
          const idPropValue = (item as any)[`${fk.propertyName}Id`];

          if (relatedValue != null) {
            if (typeof relatedValue === "object") {
              const RelatedEntity = fk.relMeta.getMappingEntity() as ClazzType<any>;
              const relatedMeta = this.resolver.resolveEntityMetadata(RelatedEntity);
              const relatedPk = relatedMeta?.columns.find(
                (col: any) => col.options?.primary,
              );
              rowValues.push(relatedPk ? relatedValue[this.propKey(relatedPk)] ?? null : null);
            } else {
              rowValues.push(relatedValue);
            }
          } else if (idPropValue != null) {
            rowValues.push(idPropValue);
          } else {
            rowValues.push(null);
          }
        }
        return sql`(${join(rowValues, ", ")})`;
      });

      const queryStr = sql`INSERT INTO ${raw(this.wrapTable(metadata.name!))} (${join(columns, ", ")}) VALUES ${join(valueRows, ", ")}`;

      const queryResult = (await session.query(queryStr)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };

      let affected = items.length;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? items.length;
      } else if (queryResult?.rowCount !== undefined) {
        affected = queryResult.rowCount;
      }

      return { affected };
    });
  }

  // ── CRUD: Delete ────────────────────────────────────────────

  async delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    this.validateCriteriaKeys(metadata, criteria, entity.name);

    return this.executeInTransaction(async (session) => {
      await this.cascadeHandler.runHooks(entity, criteria, "beforeDelete");
      await this.eventEmitter.emit("beforeDelete", { entity, data: criteria });
      await this.notifySubscribers(entity, "beforeDelete", {
        entityClass: entity,
        criteria,
        manager: this,
      } as DeleteEvent<T>);

      // cascade remove
      await this.cascadeHandler.cascadeDeleteOneToMany(entity, criteria);

      const deletePropToCol = this.buildPropertyToColumnMap(metadata);
      const whereMap: Sql[] = [];
      for (const key in criteria) {
        const value = (criteria as any)[key];
        if (value !== undefined && value !== null) {
          const dbCol = deletePropToCol.get(key) ?? key;
          const col = this.wrap(dbCol);
          whereMap.push(
            Array.isArray(value)
              ? Conditions.in(col, value)
              : Conditions.equals(col, value),
          );
        }
      }

      // STI: when deleting a child entity, add the discriminator condition
      const deleteStrategy = this.inheritanceResolver.getStrategy(entity);
      if (deleteStrategy === "SINGLE_TABLE" && this.inheritanceResolver.isChildEntity(entity)) {
        const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
        const discVal = this.inheritanceResolver.getDiscriminatorValue(entity);
        if (discCol && discVal) {
          whereMap.push(Conditions.equals(this.wrap(discCol.name), discVal));
        }
      }

      // Empty-criteria guard MUST run before we append the tenant predicate —
      // otherwise tenant scoping alone would satisfy the check and permit a
      // "delete all my rows" call. DeleteWithoutConditionsError catches that
      // class of bug and must stay gated on user-supplied criteria only.
      if (whereMap.length === 0) {
        throw new DeleteWithoutConditionsError("Delete");
      }

      // Tenant scoping is added after the guard so a delete with a user
      // criteria is safely intersected with the tenant filter.
      const tenantDeleteWhere = this.buildTenantWhereClause(entity);
      if (tenantDeleteWhere) {
        whereMap.push(tenantDeleteWhere);
      }

      const whereSql = join(whereMap, " AND ");

      // TPT: delete from the child table first, then the parent
      if (deleteStrategy === "JOINED" && this.inheritanceResolver.isChildEntity(entity)) {
        const root = this.inheritanceResolver.getRoot(entity)!;
        const rootMeta = this.resolver.resolveEntityMetadata(root);
        if (rootMeta) {
          // 1. Delete from the child table
          const childDeleteQuery = sql`DELETE FROM ${raw(this.wrapTable(metadata.name!))} WHERE ${whereSql}`;
          await session.query(childDeleteQuery);

          // 2. Delete from the parent table
          const parentDeleteQuery = sql`DELETE FROM ${raw(this.wrapTable(rootMeta.name!))} WHERE ${whereSql}`;
          const parentResult = (await session.query(parentDeleteQuery)) as {
            results: any;
            rowCount?: number;
          };

          let affected = 0;
          if (this.isMySqlFamily()) {
            affected = parentResult?.results?.affectedRows ?? 0;
          } else {
            affected = parentResult?.rowCount ?? 0;
          }

          await this.cascadeHandler.runHooks(entity, criteria, "afterDelete");
          await this.eventEmitter.emit("afterDelete", {
            entity,
            data: criteria,
          });
          await this.notifySubscribers(entity, "afterDelete", {
            entityClass: entity,
            criteria,
            manager: this,
          } as DeleteEvent<T>);

          return { affected };
        }
      }

      const deleteQuery = sql`DELETE FROM ${raw(this.wrapTable(metadata.name!))} WHERE ${whereSql}`;

      const deleteStart = Date.now();
      this.beginTrackQuery();
      const queryResult = (await session.query(deleteQuery)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };
      this.trackQuery(
        entity.name,
        deleteQuery.text ?? String(deleteQuery),
        Date.now() - deleteStart,
      );

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      await this.cascadeHandler.runHooks(entity, criteria, "afterDelete");
      await this.eventEmitter.emit("afterDelete", { entity, data: criteria });
      await this.notifySubscribers(entity, "afterDelete", {
        entityClass: entity,
        criteria,
        manager: this,
      } as DeleteEvent<T>);

      return { affected };
    });
  }

  async deleteMany<T>(entity: ClazzType<T>, ids: unknown[]): Promise<DeleteResult> {
    if (ids.length === 0) {
      return { affected: 0 };
    }

    for (const id of ids) {
      if (typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint") {
        throw new InvalidQueryError(
          `deleteMany() expects scalar primary key values (string | number | bigint), but received ${typeof id}`,
          "Pass only primitive ID values, e.g. deleteMany(User, [1, 2, 3])",
        );
      }
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const pk = metadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    return this.executeInTransaction(async (session) => {
      const placeholders = join(
        ids.map((id) => sql`${id as string | number}`),
        ", ",
      );

      // Tenant scoping — PKs may collide across tenants (e.g. autoIncrement
      // resets per schema), so `deleteMany([1, 2])` under tenant A must not
      // affect tenant B's rows with the same IDs.
      const tenantDeleteManyWhere = this.buildTenantWhereClause(entity);
      const deleteQuery = tenantDeleteManyWhere
        ? sql`DELETE FROM ${raw(this.wrapTable(metadata.name!))} WHERE ${raw(this.wrap(pk.name!))} IN (${placeholders}) AND ${tenantDeleteManyWhere}`
        : sql`DELETE FROM ${raw(this.wrapTable(metadata.name!))} WHERE ${raw(this.wrap(pk.name!))} IN (${placeholders})`;

      const queryResult = (await session.query(deleteQuery)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      return { affected };
    });
  }

  async clear<T>(entity: ClazzType<T>): Promise<void> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "Driver is not initialized. Call connect() first.",
      );
    }

    await this.driver.clear(metadata.name!);
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
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const { where, orderBy, limit } = options;
    if (!where || Object.keys(where).length === 0) {
      throw new DeleteWithoutConditionsError("Update");
    }

    if (limit !== undefined) {
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
        throw new InvalidQueryError(
          `updateMany limit must be a non-negative integer, got ${String(limit)}`,
        );
      }
    }

    this.validateCriteriaKeys(metadata, data as WhereClause<T>, entity.name);
    this.validateCriteriaKeys(metadata, where, entity.name);

    return this.executeInTransaction(async (session) => {
      const updatePropToCol = this.buildPropertyToColumnMap(metadata);
      const setMap: Sql[] = [];
      for (const key in data) {
        const value = (data as any)[key];
        if (value !== undefined) {
          const dbCol = updatePropToCol.get(key) ?? key;
          setMap.push(sql`${raw(this.wrap(dbCol))} = ${value}`);
        }
      }

      // @UpdateTimestamp auto-inject
      const updateTsColName = this.resolver.getUpdateTimestampColumn(entity);
      if (updateTsColName) {
        const hasExplicit = setMap.some(
          (s) => s.text?.includes(this.wrap(updateTsColName)),
        );
        if (!hasExplicit) {
          setMap.push(
            sql`${raw(this.wrap(updateTsColName))} = ${formatDateTimeForSQL(new Date())}`,
          );
        }
      }

      if (setMap.length === 0) {
        return { affected: 0 };
      }

      const whereMap: Sql[] = resolveWhereClause(where, {
        wrapColumn: (n) => this.wrap(n),
        dialect: this._ctx.getDialect(),
        dialectExpression: createDialectExpression(this._ctx.getDialect()),
        propertyToColumn: updatePropToCol,
      });

      // Tenant scoping — intersected with the user's WHERE so an updateMany
      // can never cross tenant boundaries. The empty-criteria guard above
      // runs on user input only; tenant predicate is appended here.
      const tenantUpdateWhere = this.buildTenantWhereClause(entity);
      if (tenantUpdateWhere) {
        whereMap.push(tenantUpdateWhere);
      }

      const orderBySql = this.buildUpdateOrderBy(orderBy, updatePropToCol);

      const updateSql = this.buildUpdateSql(
        metadata,
        entity.name,
        setMap,
        whereMap,
        orderBySql,
        limit,
      );

      const queryStart = Date.now();
      this.beginTrackQuery();
      const queryResult = (await session.query(updateSql)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };
      this.trackQuery(
        entity.name,
        updateSql.text ?? String(updateSql),
        Date.now() - queryStart,
      );

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      return { affected };
    });
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
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }
    if (whereConditions.length === 0) {
      throw new DeleteWithoutConditionsError("Update");
    }
    return this.buildUpdateSql(
      metadata,
      entity.name,
      setMap,
      whereConditions,
      orderBySql,
      limit,
    );
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
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }
    if (whereConditions.length === 0) {
      throw new DeleteWithoutConditionsError("Update");
    }
    if (limit !== undefined) {
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
        throw new InvalidQueryError(
          `UpdateQueryBuilder.limit must be a non-negative integer, got ${String(limit)}`,
        );
      }
    }

    return this.executeInTransaction(async (session) => {
      let mergedSetMap = setEntries;

      // @UpdateTimestamp auto-inject (same logic as updateMany)
      const updateTsColName = this.resolver.getUpdateTimestampColumn(entity);
      if (updateTsColName) {
        const wrappedTs = this.wrap(updateTsColName);
        const hasExplicit = setEntries.some((s) =>
          s.text?.includes(wrappedTs),
        );
        if (!hasExplicit) {
          mergedSetMap = [
            ...setEntries,
            sql`${raw(wrappedTs)} = ${formatDateTimeForSQL(new Date())}`,
          ];
        }
      }

      if (mergedSetMap.length === 0) {
        return { affected: 0 };
      }

      const whereMap = [...whereConditions];
      const tenantWhere = this.buildTenantWhereClause(entity);
      if (tenantWhere) {
        whereMap.push(tenantWhere);
      }

      const updateSql = this.buildUpdateSql(
        metadata,
        entity.name,
        mergedSetMap,
        whereMap,
        orderBySql,
        limit,
      );

      const queryStart = Date.now();
      this.beginTrackQuery();
      const queryResult = (await session.query(updateSql)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };
      this.trackQuery(
        entity.name,
        updateSql.text ?? String(updateSql),
        Date.now() - queryStart,
      );

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }
      return { affected };
    });
  }

  /**
   * Builds the ORDER BY fragment for an UPDATE statement.
   * Direction is sanitized to ASC/DESC; column names go through the
   * property→column map and the driver's identifier wrap.
   */
  private buildUpdateOrderBy(
    orderBy: { [k: string]: "ASC" | "DESC" } | undefined,
    propertyToColumn: Map<string, string>,
  ): Sql | undefined {
    if (!orderBy) return undefined;
    const entries = Object.entries(orderBy);
    if (entries.length === 0) return undefined;

    const items: Sql[] = [];
    for (const [prop, dir] of entries) {
      const dbCol = propertyToColumn.get(prop) ?? prop;
      const direction =
        typeof dir === "string" && dir.toUpperCase() === "DESC"
          ? "DESC"
          : "ASC";
      items.push(sql`${raw(this.wrap(dbCol))} ${raw(direction)}`);
    }
    return sql`ORDER BY ${join(items, ", ")}`;
  }

  /**
   * Builds the final UPDATE SQL, dialect-aware:
   *
   * - MySQL/MariaDB: native `UPDATE … SET … WHERE … [ORDER BY …] [LIMIT n]`.
   * - PostgreSQL / SQLite: when `orderBy` or `limit` is set, rewrites to
   *   `UPDATE t SET … WHERE pk IN (SELECT pk FROM t WHERE … [ORDER BY …] [LIMIT n])`,
   *   because those dialects don't accept ORDER BY / LIMIT directly on UPDATE.
   *   Composite-PK entities can't take that path and throw an
   *   `UNSUPPORTED_OPERATION` error; the caller can fall back to a custom
   *   subquery via `createUpdateBuilder` (or stay on MySQL).
   */
  private buildUpdateSql(
    metadata: any,
    entityName: string,
    setMap: Sql[],
    whereMap: Sql[],
    orderBySql: Sql | undefined,
    limit: number | undefined,
  ): Sql {
    const tableSql = raw(this.wrapTable(metadata.name!));
    const setSql = join(setMap, ", ");
    const whereSql = join(whereMap, " AND ");
    const limitSql =
      limit !== undefined ? sql` LIMIT ${raw(String(limit))}` : sql``;
    const orderPart = orderBySql ? sql` ${orderBySql}` : sql``;

    if (this.isMySqlFamily()) {
      return sql`UPDATE ${tableSql} SET ${setSql} WHERE ${whereSql}${orderPart}${limitSql}`;
    }

    if (orderBySql === undefined && limit === undefined) {
      return sql`UPDATE ${tableSql} SET ${setSql} WHERE ${whereSql}`;
    }

    // PostgreSQL / SQLite — subquery rewrite via PK
    const pkColumns = metadata.columns.filter(
      (c: any) => c.options?.primary,
    );
    if (pkColumns.length === 0) {
      throw new OrmError(
        OrmErrorCode.PRIMARY_KEY_NOT_FOUND,
        `updateMany() with orderBy/limit requires a primary key on "${entityName}" (this dialect needs a subquery rewrite).`,
        `Add @PrimaryColumn / @PrimaryGeneratedColumn to "${entityName}" or run on MySQL/MariaDB.`,
      );
    }
    if (pkColumns.length > 1) {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_OPERATION,
        `updateMany() with orderBy/limit on composite-PK entity "${entityName}" is not supported on PostgreSQL/SQLite.`,
        `Use createUpdateBuilder() with a manually scoped subquery, or run the update on MySQL/MariaDB which supports UPDATE … ORDER BY … LIMIT natively.`,
      );
    }
    const pkWrapped = raw(this.wrap(pkColumns[0].name!));
    const subquery = sql`SELECT ${pkWrapped} FROM ${tableSql} WHERE ${whereSql}${orderPart}${limitSql}`;
    return sql`UPDATE ${tableSql} SET ${setSql} WHERE ${pkWrapped} IN (${subquery})`;
  }

  async softDelete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
    if (!deletedAtColumn) {
      throw new InvalidQueryError(
        `Entity "${entity.name}" does not have a @DeletedAt column. Use delete() instead.`,
        `Add @DeletedAt() decorator to a Date column in "${entity.name}" to enable soft delete.`,
      );
    }

    this.validateCriteriaKeys(metadata, criteria, entity.name);

    return this.executeInTransaction(async (session) => {
      const sdPropToCol = this.buildPropertyToColumnMap(metadata);
      const whereMap: Sql[] = [];
      for (const key in criteria) {
        const value = (criteria as any)[key];
        if (value !== undefined && value !== null) {
          const dbCol = sdPropToCol.get(key) ?? key;
          const col = this.wrap(dbCol);
          whereMap.push(
            Array.isArray(value)
              ? Conditions.in(col, value)
              : Conditions.equals(col, value),
          );
        }
      }

      if (whereMap.length === 0) {
        throw new DeleteWithoutConditionsError("Soft delete");
      }

      // Tenant scoping — added after the empty-criteria guard so the user
      // still needs to specify a target, and the tenant filter narrows it.
      const tenantSoftDeleteWhere = this.buildTenantWhereClause(entity);
      if (tenantSoftDeleteWhere) {
        whereMap.push(tenantSoftDeleteWhere);
      }

      const whereSql = join(whereMap, " AND ");

      const nowExpr = this.isSqlite() ? raw("datetime('now')") : raw("NOW()");
      const updateQuery = sql`UPDATE ${raw(this.wrapTable(metadata.name!))} SET ${raw(this.wrap(deletedAtColumn))} = ${nowExpr} WHERE ${whereSql}`;

      const queryResult = (await session.query(updateQuery)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      return { affected };
    });
  }

  async restore<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
    if (!deletedAtColumn) {
      throw new InvalidQueryError(
        `Entity "${entity.name}" does not have a @DeletedAt column. Cannot restore.`,
        `Add @DeletedAt() decorator to a Date column in "${entity.name}" to enable soft delete/restore.`,
      );
    }

    this.validateCriteriaKeys(metadata, criteria, entity.name);

    return this.executeInTransaction(async (session) => {
      const restorePropToCol = this.buildPropertyToColumnMap(metadata);
      const whereMap: Sql[] = [];
      for (const key in criteria) {
        const value = (criteria as any)[key];
        if (value !== undefined && value !== null) {
          const dbCol = restorePropToCol.get(key) ?? key;
          const col = this.wrap(dbCol);
          whereMap.push(
            Array.isArray(value)
              ? Conditions.in(col, value)
              : Conditions.equals(col, value),
          );
        }
      }

      if (whereMap.length === 0) {
        throw new DeleteWithoutConditionsError("Restore");
      }

      // Tenant scoping — symmetrical with softDelete so restore can only
      // bring back rows belonging to the active tenant.
      const tenantRestoreWhere = this.buildTenantWhereClause(entity);
      if (tenantRestoreWhere) {
        whereMap.push(tenantRestoreWhere);
      }

      const whereSql = join(whereMap, " AND ");

      const restoreQuery = sql`UPDATE ${raw(this.wrapTable(metadata.name!))} SET ${raw(this.wrap(deletedAtColumn))} = NULL WHERE ${whereSql}`;

      const queryResult = (await session.query(restoreQuery)) as {
        results: any;
        fields: any;
        rowCount?: number;
      };

      let affected = 0;
      if (this.isMySqlFamily()) {
        affected = queryResult?.results?.affectedRows ?? 0;
      } else {
        affected = queryResult?.rowCount ?? 0;
      }

      return { affected };
    });
  }

  // ── Upsert ────────────────────────────────────────────────

  async upsert<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<void> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "Driver is not initialized. Call connect() first.",
      );
    }

    this.applyTenantColumnOnInsert(entity, data);

    const pkColumns = metadata.columns
      .filter((col: ColumnMetadata) => col.options?.primary)
      .map((col: ColumnMetadata) => col.name!);

    const resolvedConflictColumns = conflictColumns ?? pkColumns;

    if (resolvedConflictColumns.length === 0) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    const computedColsUpsert = this.getComputedColumnNames(entity);
    const insertableColumns = metadata.columns.filter((col: ColumnMetadata) => {
      if (computedColsUpsert.has(col.name!)) return false;
      const value = (data as any)[this.propKey(col)];
      if (
        col.options?.autoIncrement &&
        (value === null || value === undefined)
      ) {
        return false;
      }
      return value !== undefined;
    });

    if (insertableColumns.length === 0) {
      return;
    }

    const conflictSet = new Set(resolvedConflictColumns);
    const updateColumnNames = insertableColumns
      .map((col: ColumnMetadata) => col.name!)
      .filter((name) => !conflictSet.has(name));

    const wrappedColumns = insertableColumns.map((col: ColumnMetadata) =>
      this.wrap(col.name!),
    );
    const wrappedConflict = resolvedConflictColumns.map((name) =>
      this.wrap(name),
    );
    const wrappedUpdate = updateColumnNames.map((name) => this.wrap(name));

    const tableName = this.wrapTable(metadata.name!);

    if (wrappedUpdate.length === 0) {
      return;
    }

    await this.executeInTransaction(async (session) => {
      const columnValues = insertableColumns.map(
        (col: ColumnMetadata) => {
          const rawValue = (data as any)[this.propKey(col)];
          return this.applyWriteTransform(col, rawValue);
        },
      );

      const upsertSql = this.buildUpsertQuery(
        tableName,
        wrappedColumns,
        columnValues,
        wrappedConflict,
        wrappedUpdate,
      );

      await session.query(upsertSql);
    });
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
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "Driver is not initialized. Call connect() first.",
      );
    }

    this.applyTenantColumnOnInsert(entity, data);

    const pkColumns = metadata.columns
      .filter((col: ColumnMetadata) => col.options?.primary)
      .map((col: ColumnMetadata) => col.name!);

    const resolvedConflictColumns = conflictColumns ?? pkColumns;
    if (resolvedConflictColumns.length === 0) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    const computedColsIgnore = this.getComputedColumnNames(entity);
    const insertableColumns = metadata.columns.filter((col: ColumnMetadata) => {
      if (computedColsIgnore.has(col.name!)) return false;
      const value = (data as any)[this.propKey(col)];
      if (
        col.options?.autoIncrement &&
        (value === null || value === undefined)
      ) {
        return false;
      }
      return value !== undefined;
    });

    if (insertableColumns.length === 0) {
      return { affected: 0 };
    }

    const wrappedColumns = insertableColumns.map((col: ColumnMetadata) =>
      this.wrap(col.name!),
    );
    const wrappedConflict = resolvedConflictColumns.map((name) =>
      this.wrap(name),
    );
    const tableName = this.wrapTable(metadata.name!);

    return this.executeInTransaction(async (session) => {
      const columnValues = insertableColumns.map((col: ColumnMetadata) => {
        const rawValue = (data as any)[this.propKey(col)];
        return this.applyWriteTransform(col, rawValue);
      });

      const insertSql = this.buildInsertIgnoreQuery(
        tableName,
        wrappedColumns,
        columnValues,
        wrappedConflict,
      );

      const queryResult: any = await session.query(insertSql);
      const affected = this.isMySqlFamily()
        ? (queryResult?.results?.affectedRows ?? 0)
        : (queryResult?.rowCount ?? 0);
      return { affected };
    });
  }

  private buildInsertIgnoreQuery(
    tableName: string,
    columns: string[],
    values: any[],
    conflictColumns: string[],
  ): Sql {
    const columnList = join(
      columns.map((c) => raw(c)),
      ", ",
    );
    const valueList = join(values, ", ");

    if (this.isMySqlFamily()) {
      return sql`INSERT IGNORE INTO ${raw(tableName)} (${columnList}) VALUES (${valueList})`;
    }

    const conflictList = join(
      conflictColumns.map((c) => raw(c)),
      ", ",
    );
    if (this.isPostgres()) {
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON CONFLICT (${conflictList}) DO NOTHING`;
    }

    if ((this.dbType ?? (this.client as any).type) === "sqlite") {
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON CONFLICT (${conflictList}) DO NOTHING`;
    }

    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      `Unsupported database type for insertIgnore: ${this.dbType}`,
    );
  }

  private buildUpsertQuery(
    tableName: string,
    columns: string[],
    values: any[],
    conflictColumns: string[],
    updateColumns: string[],
  ): Sql {
    const columnList = join(
      columns.map((c) => raw(c)),
      ", ",
    );
    const valueList = join(values, ", ");

    if (this.isMySqlFamily()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = VALUES(${col})`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON DUPLICATE KEY UPDATE ${updateSet}`;
    }

    const conflictList = join(
      conflictColumns.map((c) => raw(c)),
      ", ",
    );

    if (this.isPostgres()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = EXCLUDED.${col}`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    }

    // SQLite
    if ((this.dbType ?? (this.client as any).type) === "sqlite") {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = excluded.${col}`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES (${valueList}) ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    }

    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      `Unsupported database type for upsert: ${this.dbType}`,
    );
  }

  // ── Batch Upsert ──────────────────────────────────────────

  async batchUpsert<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
    conflictColumns?: string[],
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    if (!this.driver) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "Driver is not initialized. Call connect() first.",
      );
    }

    if (this.tenantColumnConfig) {
      for (const item of items) {
        this.applyTenantColumnOnInsert(entity, item);
      }
    }

    const pkColumns = metadata.columns
      .filter((col: ColumnMetadata) => col.options?.primary)
      .map((col: ColumnMetadata) => col.name!);

    const resolvedConflictColumns = conflictColumns ?? pkColumns;

    if (resolvedConflictColumns.length === 0) {
      throw new PrimaryKeyNotFoundError(entity.name);
    }

    const computedCols = this.getComputedColumnNames(entity);
    const conflictSet = new Set(resolvedConflictColumns);

    // Determine insertable columns from the union of all items' defined fields
    const insertableColumns = metadata.columns.filter((col: ColumnMetadata) => {
      if (computedCols.has(col.name!)) return false;
      if (col.options?.autoIncrement) {
        // Include auto-increment column only if ALL items provide a value
        return items.every(
          (item) =>
            (item as any)[this.propKey(col)] !== null &&
            (item as any)[this.propKey(col)] !== undefined,
        );
      }
      // Include column if at least one item provides a value
      return items.some((item) => (item as any)[this.propKey(col)] !== undefined);
    });

    if (insertableColumns.length === 0) {
      return;
    }

    const updateColumnNames = insertableColumns
      .map((col: ColumnMetadata) => col.name!)
      .filter((name) => !conflictSet.has(name));

    if (updateColumnNames.length === 0) {
      return;
    }

    const wrappedColumns = insertableColumns.map((col: ColumnMetadata) =>
      this.wrap(col.name!),
    );
    const wrappedConflict = resolvedConflictColumns.map((name) =>
      this.wrap(name),
    );
    const wrappedUpdate = updateColumnNames.map((name) => this.wrap(name));
    const tableName = this.wrapTable(metadata.name!);

    await this.executeInTransaction(async (session) => {
      const valueRows = items.map((item) => {
        const rowValues = insertableColumns.map((col: ColumnMetadata) => {
          const rawValue = (item as any)[this.propKey(col)];
          const transformed = this.applyWriteTransform(col, rawValue);
          if (transformed instanceof Date) return formatDateTimeForSQL(transformed);
          return transformed ?? null;
        });
        return sql`(${join(rowValues, ", ")})`;
      });

      const upsertSql = this.buildBatchUpsertQuery(
        tableName,
        wrappedColumns,
        valueRows,
        wrappedConflict,
        wrappedUpdate,
      );

      await session.query(upsertSql);
    });
  }

  private buildBatchUpsertQuery(
    tableName: string,
    columns: string[],
    valueRows: Sql[],
    conflictColumns: string[],
    updateColumns: string[],
  ): Sql {
    const columnList = join(
      columns.map((c) => raw(c)),
      ", ",
    );
    const valuesList = join(valueRows, ", ");

    if (this.isMySqlFamily()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = VALUES(${col})`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES ${valuesList} ON DUPLICATE KEY UPDATE ${updateSet}`;
    }

    const conflictList = join(
      conflictColumns.map((c) => raw(c)),
      ", ",
    );

    if (this.isPostgres()) {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = EXCLUDED.${col}`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES ${valuesList} ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    }

    // SQLite
    if ((this.dbType ?? (this.client as any).type) === "sqlite") {
      const updateSet = join(
        updateColumns.map((col) => raw(`${col} = excluded.${col}`)),
        ", ",
      );
      return sql`INSERT INTO ${raw(tableName)} (${columnList}) VALUES ${valuesList} ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    }

    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      `Unsupported database type for upsert: ${this.dbType}`,
    );
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
    const ignoreExisting = options.ignoreExisting !== false;
    const join = this.resolveJoinTableForRelation(entity, propertyKey);

    const tableName = this.wrapTable(join.tableName);
    const ownerCol = this.wrap(join.ownerColumn);
    const relatedCol = this.wrap(join.relatedColumn);

    return this.executeInTransaction(async (session) => {
      const insertSql = ignoreExisting
        ? this.buildInsertIgnoreJoinTableSql(
            tableName,
            ownerCol,
            relatedCol,
            ownerId,
            relatedId,
          )
        : sql`INSERT INTO ${raw(tableName)} (${raw(ownerCol)}, ${raw(relatedCol)}) VALUES (${ownerId as any}, ${relatedId as any})`;
      const queryResult: any = await session.query(insertSql);
      const affected = this.isMySqlFamily()
        ? (queryResult?.results?.affectedRows ?? 0)
        : (queryResult?.rowCount ?? 0);
      return { affected };
    });
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
    const join = this.resolveJoinTableForRelation(entity, propertyKey);

    const tableName = this.wrapTable(join.tableName);
    const ownerCol = this.wrap(join.ownerColumn);
    const relatedCol = this.wrap(join.relatedColumn);

    return this.executeInTransaction(async (session) => {
      const deleteSql = sql`DELETE FROM ${raw(tableName)} WHERE ${raw(ownerCol)} = ${ownerId as any} AND ${raw(relatedCol)} = ${relatedId as any}`;
      const queryResult: any = await session.query(deleteSql);
      const affected = this.isMySqlFamily()
        ? (queryResult?.results?.affectedRows ?? 0)
        : (queryResult?.rowCount ?? 0);
      return { affected };
    });
  }

  /**
   * @internal Resolve the join-table descriptor for a M2M property,
   * normalizing owning-side (`joinTable`) and inverse-side (`mappedBy`)
   * declarations to the same shape: `{ tableName, ownerColumn, relatedColumn }`,
   * where `ownerColumn` is the FK back to `entity` and `relatedColumn`
   * points at the other side.
   */
  private resolveJoinTableForRelation<T>(
    entity: ClazzType<T>,
    propertyKey: keyof T & string,
  ): { tableName: string; ownerColumn: string; relatedColumn: string } {
    const relations = this.resolver.resolveManyToManyMetadata(entity);
    const meta = relations.find((r) => r.propertyKey === propertyKey);
    if (!meta) {
      throw new InvalidQueryError(
        `attachRelation/detachRelation: "${entity.name}.${propertyKey}" is not a @ManyToMany relation`,
      );
    }

    if (meta.joinTable) {
      return {
        tableName: meta.joinTable.name,
        ownerColumn: meta.joinTable.joinColumn,
        relatedColumn: meta.joinTable.inverseJoinColumn,
      };
    }

    if (meta.mappedBy) {
      const inverseEntity = meta.getRelatedEntity() as ClazzType<any>;
      const inverseRelations =
        this.resolver.resolveManyToManyMetadata(inverseEntity);
      const owning = inverseRelations.find(
        (r) => r.propertyKey === meta.mappedBy && r.joinTable,
      );
      if (!owning?.joinTable) {
        throw new InvalidQueryError(
          `attachRelation/detachRelation: "${entity.name}.${propertyKey}" is the inverse side of a @ManyToMany but the owning side "${inverseEntity.name}.${meta.mappedBy}" does not declare \`joinTable\``,
        );
      }
      // The owning side names the columns from its own perspective; from
      // the inverse side, the FK back to `entity` is `inverseJoinColumn`.
      return {
        tableName: owning.joinTable.name,
        ownerColumn: owning.joinTable.inverseJoinColumn,
        relatedColumn: owning.joinTable.joinColumn,
      };
    }

    throw new InvalidQueryError(
      `attachRelation/detachRelation: "${entity.name}.${propertyKey}" has no \`joinTable\` or \`mappedBy\` configured`,
    );
  }

  /**
   * @internal Build a dialect-portable "insert if missing" against a join
   * table. `tableName`, `ownerCol`, `relatedCol` are already wrapped.
   */
  private buildInsertIgnoreJoinTableSql(
    tableName: string,
    ownerCol: string,
    relatedCol: string,
    ownerId: unknown,
    relatedId: unknown,
  ): Sql {
    if (this.isMySqlFamily()) {
      return sql`INSERT IGNORE INTO ${raw(tableName)} (${raw(ownerCol)}, ${raw(relatedCol)}) VALUES (${ownerId as any}, ${relatedId as any})`;
    }
    // PostgreSQL + SQLite both support ON CONFLICT DO NOTHING.
    return sql`INSERT INTO ${raw(tableName)} (${raw(ownerCol)}, ${raw(relatedCol)}) VALUES (${ownerId as any}, ${relatedId as any}) ON CONFLICT DO NOTHING`;
  }

  // ── Aggregate delegation ─────────────────────────────────────────────

  /**
   * Returns true if at least one entity matches the given where clause.
   */
  async exists<T>(
    entity: ClazzType<T>,
    where?: WhereClause<T>,
  ): Promise<boolean> {
    const c = await this.aggregateHandler.count(entity, where);
    return c > 0;
  }

  /**
   * Finds a single entity by its primary key value.
   * For composite PKs, pass an object with PK field names as keys.
   */
  async findByPK<T>(
    entity: ClazzType<T>,
    id: unknown,
  ): Promise<T | null> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) throw new EntityMetadataNotFoundError(entity.name);
    const pkColumns = metadata.columns.filter(
      (col: ColumnMetadata) => col.options?.primary,
    );
    if (pkColumns.length === 0) {
      throw new InvalidQueryError(
        `Entity "${metadata.name}" has no primary key.`,
        "Add @PrimaryGeneratedColumn() or @PrimaryColumn() to your entity.",
      );
    }

    let where: WhereClause<T>;
    if (pkColumns.length === 1) {
      where = { [this.propKey(pkColumns[0])]: id } as WhereClause<T>;
    } else {
      where = id as WhereClause<T>;
    }

    return this.findOne<T>(entity, { where });
  }

  /**
   * Finds multiple entities by their primary key values.
   * For composite PKs, pass an array of objects with PK field names as keys.
   */
  async findByPKs<T>(
    entity: ClazzType<T>,
    ids: unknown[],
  ): Promise<T[]> {
    if (ids.length === 0) return [];

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) throw new EntityMetadataNotFoundError(entity.name);
    const pkColumns = metadata.columns.filter(
      (col: ColumnMetadata) => col.options?.primary,
    );
    if (pkColumns.length === 0) {
      throw new InvalidQueryError(
        `Entity "${metadata.name}" has no primary key.`,
        "Add @PrimaryGeneratedColumn() or @PrimaryColumn() to your entity.",
      );
    }

    if (pkColumns.length === 1) {
      const where = { [this.propKey(pkColumns[0])]: { in: ids } } as WhereClause<T>;
      return this.find<T>(entity, { where });
    }

    // Composite PK: use OR conditions
    const where = { OR: ids } as WhereClause<T>;
    return this.find<T>(entity, { where });
  }

  async count<T>(
    entity: ClazzType<T>,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregateHandler.count(entity, where);
  }

  async sum<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregateHandler.sum(entity, field, where);
  }

  async avg<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregateHandler.avg(entity, field, where);
  }

  async min<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregateHandler.min(entity, field, where);
  }

  async max<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregateHandler.max(entity, field, where);
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
    metadata: { columns: ColumnMetadata[] },
    criteria: WhereClause<T>,
    entityName: string,
  ): void {
    const validNames = new Set<string>();
    for (const col of metadata.columns) {
      if (col.propertyKey) validNames.add(col.propertyKey);
      if (col.name) validNames.add(col.name);
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
  private propKey(col: { propertyKey?: string; name?: string }): string {
    return col.propertyKey ?? col.name!;
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
    const map = new Map<string, string>();
    for (const col of metadata.columns) {
      const prop = col.propertyKey ?? col.name!;
      map.set(prop, col.name!);
    }
    // Resolver may be a partial mock in some tests, so guard the call.
    if (
      metadata.target &&
      typeof this.resolver?.collectFkPropertyMappings === "function"
    ) {
      const fkMap = this.resolver.collectFkPropertyMappings(metadata.target);
      for (const [prop, col] of fkMap) {
        // Explicit @Column on the same property wins (already in map).
        if (!map.has(prop)) map.set(prop, col);
      }
    }
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
   * Wrap a table name with optional schema qualification for multi-tenant queries.
   * Uses the configured TenantQueryStrategy to determine whether to prefix with tenant schema.
   */
  wrapTable(tableName: string): string {
    const tenant = this.isPostgres()
      ? MetadataContext.getCurrentTenant()
      : "public";
    return this.tenantStrategy.qualifyTable(tableName, tenant, (n) =>
      this.wrap(n),
    );
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
    return this.tenantColumnConfig;
  }

  /**
   * Returns the active TenantQueryStrategy — exposed for advanced use cases
   * (custom query builders, testing, observability).
   */
  public getTenantStrategy(): TenantQueryStrategy {
    return this.tenantStrategy;
  }

  /**
   * Returns true when the entity is tenant-scoped under the current strategy.
   * False when tenant_column strategy is inactive or the entity is
   * `@NonTenantEntity()`.
   */
  private isTenantScopedEntity<T>(entity: ClazzType<T>): boolean {
    return this.tenantColumnConfig !== null && !isNonTenantEntity(entity);
  }

  /**
   * Returns a `tenant = ?` predicate for inclusion in WHERE, or null when no
   * filter should be applied. Consolidates the "should I scope this query?"
   * logic in one place so the read/write paths stay symmetrical.
   *
   * Returns null when:
   *   - strategy is not `"tenant_column"`
   *   - entity is `@NonTenantEntity()`
   *   - the current context is unscoped (`MetadataContext.runUnscoped`)
   *   - the current tenant is `"public"` (no tenant context active)
   *
   * The `"public"` case is intentional: reads against the public context are
   * unfiltered so admin/bootstrapping code continues to work. Write paths
   * disallow `"public"` via `applyTenantColumnOnInsert` instead.
   *
   * @param entity         Entity class
   * @param tableAliasOrName  When provided, qualifies the column (for JOINs).
   */
  private buildTenantWhereClause<T>(
    entity: ClazzType<T>,
    tableAliasOrName?: string,
  ): Sql | null {
    const config = this.tenantColumnConfig;
    if (!config) return null;
    if (isNonTenantEntity(entity)) return null;
    if (MetadataContext.isUnscoped()) return null;
    const tenant = MetadataContext.getCurrentTenant();
    if (tenant === "public") return null;

    const columnName = this.resolveTenantColumnName(entity);
    const col = tableAliasOrName
      ? `${this.wrap(tableAliasOrName)}.${this.wrap(columnName)}`
      : this.wrap(columnName);
    return Conditions.equals(col, tenant);
  }

  /**
   * Resolves the DB column name used by the tenant discriminator for this
   * entity. Honors an explicit `@TenantColumn({ name })` override, else the
   * user's property key (e.g. `tenantId`), else the global config default.
   */
  private resolveTenantColumnName<T>(entity: ClazzType<T>): string {
    const userDeclared = getTenantColumnMetadata(entity);
    if (userDeclared) {
      return userDeclared.name ?? userDeclared.propertyKey;
    }
    return this.tenantColumnConfig!.name;
  }

  /**
   * Applies tenant-column strategy to an item before INSERT:
   *   - Populates the tenant column from `MetadataContext` when missing.
   *   - Throws `MISSING_TENANT_CONTEXT` when no tenant is active on a
   *     tenant-scoped entity.
   *   - Throws `TENANT_MISMATCH` when the caller supplied a tenant value that
   *     disagrees with the current context (fail-loud; silent-replace would
   *     hide bugs).
   *
   * No-op when the strategy is not `"tenant_column"` or the entity is
   * `@NonTenantEntity()`.
   */
  private applyTenantColumnOnInsert<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): void {
    const config = this.tenantColumnConfig;
    if (!config) return;
    if (isNonTenantEntity(entity)) return;

    const tenant = MetadataContext.getCurrentTenant();
    if (tenant === "public") {
      throw new OrmError(
        OrmErrorCode.MISSING_TENANT_CONTEXT,
        `Cannot INSERT into tenant-scoped entity '${entity.name}' without an active tenant context. ` +
          `Wrap the call in MetadataContext.run("<tenant>", ...), or mark the entity with @NonTenantEntity() ` +
          `if it is intentionally global.`,
      );
    }

    // Determine where to write the tenant value:
    //   - If the user declared @TenantColumn, use the property key they chose.
    //   - Otherwise the column was implicitly injected; fall back to the column name.
    const userDeclared = getTenantColumnMetadata(entity);
    const propKey = userDeclared?.propertyKey ?? config.name;
    const colName = userDeclared?.name ?? config.name;

    const supplied =
      (item as any)[propKey] !== undefined
        ? (item as any)[propKey]
        : (item as any)[colName];

    if (supplied !== undefined && supplied !== null && supplied !== tenant) {
      throw new OrmError(
        OrmErrorCode.TENANT_MISMATCH,
        `Tenant mismatch on INSERT into '${entity.name}': supplied tenant='${supplied}' ` +
          `but MetadataContext tenant='${tenant}'. The supplied value is rejected to catch bugs early. ` +
          `Omit the tenant field so the ORM can auto-fill it, or run inside the matching context.`,
      );
    }

    (item as any)[propKey] = tenant;
    if (propKey !== colName) {
      (item as any)[colName] = tenant;
    }
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

  private async executeInTransaction<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    existingSession?: TransactionSessionManager,
    readNodeOverride?: ReplicationNodeConfig | null,
  ): Promise<R> {
    const reusable = existingSession ?? transactionStorage.getStore();
    if (reusable) {
      return fn(reusable);
    }

    const session = new TransactionSessionManager();
    try {
      if (readNodeOverride) {
        await session.connectToNode(readNodeOverride);
      } else {
        await session.connect(this.connectionName);
      }
      await this.notifyTransactionSubscribers("beforeTransactionStart");
      this.notifyPluginBeforeTransaction();
      await session.startTransaction();

      await this.notifyTransactionSubscribers("afterTransactionStart");

      const result = await fn(session);
      await this.notifyTransactionSubscribers("beforeTransactionCommit");
      await session.commit();
      this.notifyPluginAfterTransaction(true);
      await this.notifyTransactionSubscribers("afterTransactionCommit");
      return result;
    } catch (e: unknown) {
      try {
        await this.notifyTransactionSubscribers("beforeTransactionRollback");
        await session.rollback();
        this.notifyPluginAfterTransaction(false);
        await this.notifyTransactionSubscribers("afterTransactionRollback");
      } catch (rollbackError) {
        this.logger.error(`Failed to rollback transaction: ${rollbackError}`);
        const original = e instanceof Error ? e : new Error(String(e));
        const combined = new OrmError(
          OrmErrorCode.TRANSACTION_ROLLBACK_FAILED,
          `Transaction failed and rollback also failed: ${original.message}`,
        );
        (combined as any).cause = original;
        (combined as any).rollbackError = rollbackError;
        throw combined;
      }
      throw e;
    } finally {
      this.txDirtyEntities.delete(session);
      try {
        await session.close();
      } catch (closeError) {
        this.logger.error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  private async executeReadOnly<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    options?: {
      existingSession?: TransactionSessionManager;
      readNodeOverride?: ReplicationNodeConfig | null;
      timeout?: number;
    },
  ): Promise<R> {
    const { existingSession, readNodeOverride, timeout } = options ?? {};

    // 1. Reuse existing session (@Transactional or nested call)
    const reusable = existingSession ?? transactionStorage.getStore();
    if (reusable) {
      return fn(reusable);
    }

    // 2. PostgreSQL tenant or timeout → need transaction for SET LOCAL
    const tenant = this.isPostgres()
      ? MetadataContext.getCurrentTenant()
      : "public";
    const needsTxForTenant =
      this.isPostgres() &&
      tenant !== "public" &&
      this.tenantStrategy.needsTransactionForTenantRead();
    if (this.isPostgres() && (needsTxForTenant || (timeout && timeout > 0))) {
      return this.executeInTransaction(fn, existingSession, readNodeOverride);
    }

    // 3. Lightweight read-only path (no BEGIN/COMMIT)
    const session = new TransactionSessionManager();
    try {
      if (readNodeOverride) {
        await session.connectToNode(readNodeOverride);
      } else {
        await session.connect(this.connectionName);
      }

      // MySQL timeout (SET SESSION — no transaction needed)
      if (timeout && timeout > 0 && this.driver && this.isMySqlFamily()) {
        const timeoutSql = this.driver.setQueryTimeout(timeout);
        await session.query(timeoutSql);
      }

      const result = await fn(session);
      return result;
    } finally {
      try {
        await session.close();
      } catch (closeError) {
        this.logger.error(`Failed to close read-only session: ${closeError}`);
      }
    }
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

  async query<T = Record<string, unknown>>(
    sqlQuery: string | Sql,
    params?: unknown[],
  ): Promise<T[]> {
    this.warnIfRawQueryBypassesTenant();
    return this.executeInTransaction(async (session) => {
      let queryResult: any;
      if (typeof sqlQuery === "string") {
        if (params && params.length > 0) {
          const parameterizedSql = {
            text: sqlQuery,
            sql: sqlQuery,
            values: params,
            strings: [sqlQuery],
          } as unknown as Sql;
          queryResult = await session.query(parameterizedSql);
        } else {
          queryResult = await session.query(sqlQuery);
        }
      } else {
        queryResult = await session.query(sqlQuery);
      }

      if (queryResult?.results) {
        return (queryResult.results as T[]) ?? [];
      }
      if (Array.isArray(queryResult)) {
        return queryResult as T[];
      }
      return [];
    });
  }

  /**
   * Executes a callback within a database transaction.
   * Auto-commits on success, auto-rollbacks on error.
   *
   * All EntityManager operations inside the callback share the same transaction.
   *
   * @param callback A function that receives this EntityManager and performs DB operations.
   * @returns The return value of the callback.
   *
   * @example
   * ```ts
   * const result = await em.transaction(async (txEm) => {
   *   await txEm.save(User, { name: "Alice" });
   *   await txEm.save(Post, { title: "Hello", authorId: 1 });
   *   return "done";
   * });
   * ```
   */
  async transaction<R>(
    callback: (em: this) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R> {
    const maxRetries = options?.retryOnDeadlock ? (options.maxRetries ?? 3) : 0;
    const retryDelayMs = options?.retryDelayMs ?? 100;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.executeInTransaction(async (session) => {
          return transactionStorage.run(session, () => callback(this));
        });
      } catch (e: unknown) {
        lastError = e;
        if (attempt < maxRetries && isDeadlockError(e)) {
          this.logger.warn(
            `Deadlock detected (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${retryDelayMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        throw e;
      }
    }
    throw lastError;
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
   *   em.createQueryBuilder(User, "u").where("u.id = :id", { id: $.id })
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

  /**
   * Emit a one-time-per-call-site warning when `em.query()` is invoked under
   * an active tenant context while the `"tenant_column"` strategy is in use.
   *
   * Raw SQL bypasses the automatic `WHERE tenant_id = ?` injection that the
   * strategy applies to `find()` / query builders / relation loaders, so a
   * hand-written query can silently return or mutate rows belonging to other
   * tenants. The warning is suppressed when:
   *
   * - the strategy is not `tenant_column` (other strategies scope at the
   *   connection/schema level, so raw SQL is still safe)
   * - no tenant context is active (bootstrap/admin path)
   * - the current context is in `runUnscoped()` mode (user opted in)
   * - the caller is an internal ORM frame (SelectQueryBuilder, RelationLoader,
   *   RawPipeline, etc. — those builders already inject the predicate before
   *   reaching `em.query()`)
   */
  private warnIfRawQueryBypassesTenant(): void {
    if (this.tenantColumnConfig === null) return;
    if (!MetadataContext.isActive()) return;
    if (MetadataContext.isUnscoped()) return;
    const tenant = MetadataContext.getCurrentTenant();
    if (tenant === "public") return;

    const stack = new Error().stack;
    if (!stack) return;

    const lines = stack.split("\n");
    let callerFrame: string | undefined;
    for (let i = 1; i < lines.length; i++) {
      const frame = lines[i];
      // Skip frames from this file and node internals
      if (frame.includes("EntityManager.ts")) continue;
      if (frame.includes("EntityManager.js")) continue;
      if (frame.includes("node:internal")) continue;
      // Skip frames from internal ORM code — those callers either run under
      // a tenant-aware builder or are part of the scoping machinery itself.
      if (/stingerloom-orm[/\\](src|dist)[/\\]/.test(frame)) continue;
      if (/node_modules[/\\]@stingerloom[/\\]orm[/\\]/.test(frame)) continue;
      callerFrame = frame.trim();
      break;
    }
    if (!callerFrame) return;

    if (this.rawQueryTenantWarned.has(callerFrame)) return;
    this.rawQueryTenantWarned.add(callerFrame);

    this.logger.warn(
      `[multi-tenancy] em.query() called under tenant="${tenant}" — raw SQL ` +
        `bypasses automatic WHERE ${this.tenantColumnConfig.name} injection. ` +
        `Filter by the tenant column manually, or wrap the call in ` +
        `MetadataContext.runUnscoped() when cross-tenant access is intended. ` +
        `Call site: ${callerFrame}`,
    );
  }

  /**
   * Checks if a tenant context (MetadataContext.run) is active.
   * Logs a warning if not — useful in middleware/guards to catch missing context early.
   * @returns true if tenant context is active, false if falling back to "public"
   */
  assertTenantContext(): boolean {
    if (MetadataContext.isActive()) {
      return true;
    }
    this.logger.warn(
      `[multi-tenancy] No tenant context active — query will use "public" schema. ` +
        `Wrap your code in MetadataContext.run(tenantId, callback).`,
    );
    return false;
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
    const meta = this.resolver.resolveEntityMetadata(entity);
    if (!meta) return null;

    const columns = this.getColumnMetadata(entity);
    const relations = this.getRelationMetadata(entity);

    return {
      tableName: meta.name || entity.name,
      columns,
      relations,
      indexes: meta.indexes ?? [],
      deletedAtColumn: this.resolver.getDeletedAtColumn(entity),
      createTimestampColumn: this.resolver.getCreateTimestampColumn(entity),
      updateTimestampColumn: this.resolver.getUpdateTimestampColumn(entity),
      versionColumn: this.resolver.getVersionColumn(entity),
    };
  }

  /**
   * Returns column metadata for the given entity class.
   */
  getColumnMetadata<T>(entity: ClazzType<T>): ColumnMetadataView[] {
    const meta = this.resolver.resolveEntityMetadata(entity);
    if (!meta) return [];

    return (meta.columns ?? []).map((col: any) => ({
      propertyKey: col.propertyKey ?? col.name,
      columnName: col.name ?? col.propertyKey,
      type: col.options?.type ?? col.type,
      nullable: col.options?.nullable ?? false,
      primary: col.options?.primary ?? false,
      unique: col.options?.unique ?? false,
      default: col.options?.default,
      length: col.options?.length,
    }));
  }

  /**
   * Returns relation metadata for the given entity class.
   */
  getRelationMetadata<T>(entity: ClazzType<T>): RelationMetadataView[] {
    const results: RelationMetadataView[] = [];

    for (const rel of this.resolver.resolveManyToOneMetadata(entity)) {
      results.push({
        type: "ManyToOne",
        propertyKey: rel.columnName,
        target: rel.getMappingEntity(),
        joinColumn: rel.joinColumn ?? null,
        eager: rel.option?.eager ?? false,
      });
    }

    for (const rel of this.resolver.resolveOneToManyMetadata(entity)) {
      results.push({
        type: "OneToMany",
        propertyKey: rel.propertyKey,
        target: rel.getRelatedEntity(),
        joinColumn: null,
        eager: false,
      });
    }

    for (const rel of this.resolver.resolveManyToManyMetadata(entity)) {
      results.push({
        type: "ManyToMany",
        propertyKey: rel.propertyKey,
        target: rel.getRelatedEntity(),
        joinColumn: null,
        eager: false,
      });
    }

    for (const rel of this.resolver.resolveOneToOneMetadata(entity)) {
      results.push({
        type: "OneToOne",
        propertyKey: rel.propertyKey,
        target: rel.getRelatedEntity(),
        joinColumn: rel.joinColumn ?? null,
        eager: rel.option?.eager ?? false,
      });
    }

    return results;
  }
}
