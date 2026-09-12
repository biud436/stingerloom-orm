/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType, resolveEntityGlobs } from "../../utils";
import {
  DatabaseClientOptions,
  LoggingOptions,
  UnknownWriteKeyPolicy,
  validateDatabaseClientOptions,
} from "../DatabaseClientOptions";
import { DeserializerRegistry } from "../deserializer/DeserializerRegistry";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { QueryTracker } from "../QueryTracker";
import { QueryResultCache, QueryCacheOptions } from "../cache/QueryResultCache";
import type { IDatabaseType } from "../../dialects/mysql/MySqlConnector";
import type { ISqlDriver } from "../../dialects/SqlDriver";
import type { IDataSource } from "../../dialects/IDataSource";
import type { NamingStrategy } from "../generators/NamingStrategy";
import type { StingerloomPlugin } from "../plugin/StingerloomPlugin";
import type { EntityManagerInternals } from "../EntityManagerInternals";
import { applyNamingStrategyToEntities } from "./applyNamingStrategy";
import { resolveDriverPair } from "./DriverResolver";

/**
 * The slice of EntityManager state the connection lifecycle writes.
 *
 * The fields themselves stay on the EntityManager instance: tests assign
 * `em.driver` / `em.dbType` / `em.connectionName` directly, and every query
 * path reads them as plain properties. The lifecycle only ever reaches
 * them through this view, so the facade remains the single owner.
 */
export interface ConnectionLifecycleHost {
  /** `DatabaseClient` singleton. Loosely typed: legacy test mocks omit methods. */
  getClient(): any;
  setConnectionName(name: string): void;
  /** Replaces the entity scope; the facade also resets its scope-approval cache. */
  setEntities(entities: ClazzType<any>[]): void;
  markAttached(): void;
  setDbType(dbType: IDatabaseType): void;
  setDriver(driver: ISqlDriver, dataSource: IDataSource): void;
  setDefaultQueryTimeout(ms: number): void;
  setUnknownWriteKeyPolicy(policy: UnknownWriteKeyPolicy): void;
  setQueryLoggingEnabled(enabled: boolean): void;
  setQueryTracker(tracker: QueryTracker | null): void;
  setQueryCache(cache: QueryResultCache): void;
  /** Rebuilds the SchemaRegistrar so DDL follows the connection's naming strategy. */
  useNamingStrategy(strategy: NamingStrategy): void;
  registerEntities(): Promise<void>;
  configureTenantScope(options: DatabaseClientOptions): void;
  initializeReplication(config: NonNullable<DatabaseClientOptions["replication"]>): void;
  installPlugin(plugin: StingerloomPlugin): void;
}

/**
 * Connection boot engine extracted from EntityManager: `register()` (fresh
 * pool + schema sync), `connect()`, `attach()` (reuse a pool another
 * manager opened), and the shared post-connect setup that binds the driver,
 * query tracker, timeout, tenant strategy, query cache and replication.
 *
 * The facade keeps thin public delegators, so `MultiTenantEntityManager`,
 * the NestJS module and test spies keep calling the EntityManager. The one
 * internal cross-call, `register()` → `connect()`, goes back through the
 * facade for the same reason.
 *
 * @internal Package-internal — not a public API.
 */
export class ConnectionLifecycle {
  constructor(
    private readonly ctx: EntityManagerInternals,
    private readonly host: ConnectionLifecycleHost,
  ) {}

  async register(
    databaseClientOptions: DatabaseClientOptions,
    connectionName = "default",
  ): Promise<void> {
    validateDatabaseClientOptions(databaseClientOptions, connectionName);

    // ESM builds cannot probe class-transformer synchronously (no require);
    // finish the async auto-detection before any query can deserialize rows.
    await DeserializerRegistry.ensureDefaultDetected();

    if (databaseClientOptions.namingStrategy) {
      this.host.useNamingStrategy(databaseClientOptions.namingStrategy);
    }
    await this.ctx.getManager().connect(databaseClientOptions, connectionName);
    applyNamingStrategyToEntities(
      this.ctx.getEntities(),
      databaseClientOptions.namingStrategy,
    );
    await this.host.registerEntities();

    // Install plugins (in array order)
    if (databaseClientOptions.plugins) {
      for (const plugin of databaseClientOptions.plugins) {
        this.host.installPlugin(plugin);
      }
    }
  }

  async connect(
    databaseClientOptions: DatabaseClientOptions,
    connectionName = "default",
  ): Promise<void> {
    this.host.setConnectionName(connectionName);
    const resolvedEntities = await resolveEntityGlobs(
      databaseClientOptions.entities ?? [],
    );
    this.host.setEntities(resolvedEntities as ClazzType<any>[]);

    await this.host.getClient().connect(databaseClientOptions, connectionName);

    await this.initializeFromConnection(databaseClientOptions, connectionName);
  }

  /**
   * Bind to a connection `DatabaseClient` already holds under
   * `connectionName` without opening a new pool. Schema sync is forced off:
   * whoever registered the connection owns the schema.
   */
  async attach(
    connectionName: string,
    overrides?: Partial<DatabaseClientOptions>,
  ): Promise<void> {
    const client = this.host.getClient();
    if (typeof client.hasConnection === "function" && !client.hasConnection(connectionName)) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        `Cannot attach EntityManager: no DatabaseClient connection registered under '${connectionName}'.`,
        `Register the connection first (e.g. DatabaseClient.getInstance().connect(opts, '${connectionName}')) before calling attach().`,
      );
    }

    this.host.setConnectionName(connectionName);
    this.host.markAttached();
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
      this.host.useNamingStrategy(effective.namingStrategy);
    }

    const resolvedEntities = await resolveEntityGlobs(effective.entities ?? []);
    this.host.setEntities(resolvedEntities as ClazzType<any>[]);

    await this.initializeFromConnection(effective, connectionName);
    applyNamingStrategyToEntities(this.ctx.getEntities(), effective.namingStrategy);
    // synchronize: false ensures registerEntities() runs metadata setup
    // without firing any DDL — same per-EM state as register(), just no
    // schema mutation.
    await this.host.registerEntities();
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
    const client = this.host.getClient();
    const connector = client.getConnection(connectionName);
    const { schema, queryTimeout, replication } = databaseClientOptions;

    // Use getType() if available, otherwise (legacy mock) fall back to client.type
    const dbType = (
      typeof client.getType === "function"
        ? client.getType(connectionName)
        : client.type
    ) as IDatabaseType;

    this.host.setDbType(dbType);

    const { driver, dataSource } = await resolveDriverPair(dbType, connector, schema);
    this.host.setDriver(driver, dataSource);

    // Initialize QueryTracker (based on the logging options)
    this.initQueryTracker(databaseClientOptions);

    // Configure connection-level query timeout
    const isTimeoutSupported = queryTimeout && queryTimeout > 0;

    if (isTimeoutSupported) {
      this.host.setDefaultQueryTimeout(queryTimeout);
    }

    // Initialize TenantQueryStrategy
    this.host.configureTenantScope(databaseClientOptions);

    this.host.setUnknownWriteKeyPolicy(databaseClientOptions.unknownWriteKeys ?? "warn");

    // Query result cache: created eagerly when configured at register time
    // so a custom external store (e.g. Redis) receives write invalidations
    // even from a process that never issues a cached read. Without explicit
    // config it is created lazily by the first `cache`-requesting query.
    if (databaseClientOptions.cache && databaseClientOptions.cache !== true) {
      this.host.setQueryCache(
        new QueryResultCache(this.ctx, databaseClientOptions.cache),
      );
    } else if (databaseClientOptions.cache === true) {
      this.host.setQueryCache(new QueryResultCache(this.ctx));
    }

    // Initialize ReplicationRouter
    if (replication) {
      this.host.initializeReplication(replication);
    }
  }

  /** Query logging + N+1 / slow-query tracker from the `logging` option. */
  initQueryTracker(options: DatabaseClientOptions): void {
    const logging = options.logging;

    // logging: true → enable query SQL logging
    if (logging === true) {
      this.host.setQueryLoggingEnabled(true);
      return;
    }

    if (typeof logging === "object" && logging !== null) {
      const loggingOpts = logging as LoggingOptions;

      // queries: true → log generated SQL
      if (loggingOpts.queries) {
        this.host.setQueryLoggingEnabled(true);
      }

      // Disable when enableQueryTracking is explicitly set to false
      if (loggingOpts.enableQueryTracking === false) {
        this.host.setQueryTracker(null);
        return;
      }

      if (loggingOpts.nPlusOne || loggingOpts.slowQueryMs) {
        this.host.setQueryTracker(
          new QueryTracker({
            slowQueryMs: loggingOpts.slowQueryMs ?? null,
            enabled: loggingOpts.enableQueryTracking ?? true,
            maxLogEntries: loggingOpts.maxLogEntries,
            ttlMs: loggingOpts.ttlMs,
          }),
        );
      }
    }
  }

  /**
   * Lazily resolves the query result cache, honoring the `cache: false`
   * kill switch from the connection options.
   */
  resolveQueryCache(): QueryResultCache | undefined {
    const existing = this.ctx.peekQueryCache();
    if (existing) return existing;
    if (this.getQueryCacheConfig() === false) return undefined;
    const cache = new QueryResultCache(this.ctx);
    this.host.setQueryCache(cache);
    return cache;
  }

  private getQueryCacheConfig(): boolean | QueryCacheOptions | undefined {
    try {
      return this.host.getClient().getOptions(this.ctx.getConnectionName())?.cache;
    } catch {
      return undefined;
    }
  }
}
