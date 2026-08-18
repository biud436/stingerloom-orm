import { IDatabaseType, AnyEntity } from "../dialects/mysql/MySqlConnector";
import { ReplicationConfig } from "../dialects/ReplicationRouter";
import { NamingStrategy } from "./generators/NamingStrategy";
import { StingerloomPlugin } from "./plugin/StingerloomPlugin";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * Connection pool configuration options.
 * Shared between MySQL and PostgreSQL.
 * SQLite is file-based, uses a single connection, and ignores pool settings.
 */
export interface PoolOptions {
  /**
   * Maximum number of connections in the pool.
   * MySQL: connectionLimit, PostgreSQL: max
   * @default 10
   */
  max?: number;

  /**
   * Minimum number of idle connections to maintain in the pool.
   * PostgreSQL: min, MySQL: not natively supported (ignored)
   * @default 0
   */
  min?: number;

  /**
   * Maximum time (ms) to wait for a connection to become available.
   * PostgreSQL: connectionTimeoutMillis
   * @default 30000
   */
  acquireTimeoutMs?: number;

  /**
   * Time (ms) a connection can remain idle before being closed.
   * PostgreSQL: idleTimeoutMillis, MySQL: not natively supported (ignored)
   * @default 10000
   */
  idleTimeoutMs?: number;

  /**
   * Time (ms) a connection can be held before a leak warning is logged.
   * Set to 0 to disable leak detection.
   *
   * @remarks
   * NOT WIRED YET — no driver reads this option, so setting it currently has
   * no effect. {@link ConnectionLeakDetector} works but must be driven
   * manually against connections from `connector.acquireConnection()`; the
   * ORM's own transaction path checks out raw driver connections instead.
   *
   * @default 30000
   */
  leakDetectionThresholdMs?: number;

  /**
   * Validate connections with a ping/SELECT 1 before handing them to the caller.
   * Stale connections (e.g. after DB restart) are destroyed and replaced transparently.
   * MySQL uses COM_PING; PostgreSQL uses SELECT 1. SQLite ignores this option.
   * @default false
   */
  validateOnBorrow?: boolean;
}

/**
 * SSL/TLS connection options for encrypted database communication.
 * Passed directly to the underlying driver (mysql2 ssl option / pg ssl option).
 */
export interface SslOptions {
  /** CA certificate (PEM string or Buffer). Used to verify server certificate. */
  ca?: string | Buffer;
  /** Client certificate (PEM string or Buffer). For mutual TLS. */
  cert?: string | Buffer;
  /** Client private key (PEM string or Buffer). For mutual TLS. */
  key?: string | Buffer;
  /** If false, skip server certificate verification. @default true */
  rejectUnauthorized?: boolean;
}

/**
 * Common options shared by all database types.
 */
interface BaseDatabaseClientOptions {
  /** Name of the database (or file path for SQLite) to connect to */
  database: string;

  /**
   * Enable/disable schema synchronization.
   *
   * Accepts either a bare form or an options object that separates the three
   * independent concerns coupled into the bare form:
   *
   * Bare forms (kept for backward compatibility):
   * - `true`: Full synchronization — creates tables, adds/drops columns as needed.
   * - `'safe'`: Safe mode — creates tables and adds columns, but never drops columns or tables.
   * - `'dry-run'`: Preview mode — logs DDL statements that would be executed without applying them.
   * - `false` (default): No synchronization.
   *
   * Options-object form (`SynchronizeOptions`):
   * - `mode` — the bare-form behavior above (`true | "safe" | "dry-run"`).
   * - `continueOnError` — when `false`, a failing DDL statement aborts `registerEntities()`
   *    instead of degrading to a warning. Default `true` (legacy behavior).
   * - `failOnDestructiveChange` — when `true`, throws before running DROP COLUMN /
   *    DROP TABLE / narrowing ALTER (e.g. `varchar(255) → int`). Default `false`.
   * - `logDDL` — when `true`, logs every emitted DDL statement at info level.
   *    Default `false`.
   */
  synchronize?: SynchronizeOption;

  /**
   * Enable/disable query logging and diagnostics.
   * - `true`: enable basic query logging only
   * - `LoggingOptions`: detailed options (slow-query threshold, N+1 detection, etc.)
   */
  logging?: boolean | LoggingOptions;

  /**
   * Array of entity classes or glob patterns that will be used by the connection.
   * Glob patterns (e.g. `__dirname + '/**\/*.entity{.ts,.js}'`) are resolved via `fast-glob`.
   * Install `fast-glob` as a dependency if you use glob patterns.
   */
  entities: (AnyEntity | string)[];

  /** MySQL Only: Forces date types to be returned as strings */
  datesStrings?: boolean;

  /**
   * Maximum number of connections in the pool.
   * @deprecated Removal target: 2.0. Use `pool.max` instead — it wins when
   * both are set, and this option is only read as its fallback.
   */
  connectionLimit?: number;

  /** MySQL Only: The charset for the connection */
  charset?: string;

  /**
   * PostgreSQL Only: The schema to use.
   * PostgreSQL uses a three-tier structure: database → schema → table.
   * Defaults to 'public' when not specified.
   */
  schema?: string;

  /**
   * Default query timeout in milliseconds.
   * Applied to all queries unless overridden per-query via FindOption.timeout.
   * Uses driver-specific SET statements (e.g., max_execution_time for MySQL,
   * statement_timeout for PostgreSQL).
   */
  queryTimeout?: number;

  /**
   * Connection pool configuration.
   * Applies to MySQL and PostgreSQL.
   * SQLite uses a single file-based connection, so this option is ignored.
   */
  pool?: PoolOptions;

  /**
   * Connection retry configuration with exponential backoff.
   * Retries failed connections using exponential backoff.
   */
  retry?: RetryOptions;

  /**
   * Read replica (read/write split) configuration.
   * When set, reads route to slaves and writes to the master.
   * On slave failure, traffic automatically falls back to the master.
   */
  replication?: ReplicationConfig;

  /**
   * Custom naming strategy for FK constraints, indexes, and unique indexes.
   * If not provided, DefaultNamingStrategy is used (SHA1-based FK names, convention-based index names).
   */
  namingStrategy?: NamingStrategy;

  /**
   * Multi-tenant query strategy.
   * - "search_path" (default): PostgreSQL `SET LOCAL search_path` inside a transaction.
   *   Safe but 5 round-trips per tenant read. PostgreSQL only.
   * - "schema_qualified": PostgreSQL schema-qualified table names (e.g. `"tenant_a"."users"`).
   *   Single-round-trip reads without a transaction. PostgreSQL only.
   * - "tenant_column": Adds a `tenant_id` discriminator column to every entity.
   *   ORM auto-injects `WHERE tenant_id = ?` on read/update/delete and auto-fills
   *   it on INSERT from `MetadataContext`. Works on all dialects (MySQL, PostgreSQL,
   *   SQLite). See `tenantColumnName` / `tenantColumnType` / `tenantColumnLength`
   *   to customize, and `@NonTenantEntity()` to exclude specific entities.
   * - "database": Physical database-per-tenant. Use `MultiTenantEntityManager`
   *   together with `tenantDatabaseResolver` or `tenantDatabaseMap` to route
   *   each request to its own connection pool. Works on all dialects. Trades
   *   higher operational cost (one pool per tenant) for the strongest
   *   isolation, geo-distribution, and per-tenant backup/restore.
   */
  tenantStrategy?:
    | "search_path"
    | "schema_qualified"
    | "tenant_column"
    | "database";

  /**
   * Column name for the `"tenant_column"` strategy. Ignored by other strategies.
   * @default "tenant_id"
   */
  tenantColumnName?: string;

  /**
   * Column type for the `"tenant_column"` strategy. Ignored by other strategies.
   * @default "varchar"
   */
  tenantColumnType?: "varchar" | "uuid" | "int" | "bigint";

  /**
   * Length for varchar tenant column. Ignored for non-varchar types or other strategies.
   * @default 64
   */
  tenantColumnLength?: number;

  /**
   * Policy for tenant-scoped read/update/delete statements executed with
   * **no active tenant context** (`"tenant_column"` strategy only — ignored
   * by other strategies). Without a `MetadataContext.run()` wrapper the
   * automatic `WHERE tenant_id = ?` predicate cannot be built, so the
   * statement would target every tenant's rows.
   *
   * - `"warn"` (default): execute unfiltered, but log a warning once per
   *   entity class. Backward compatible with the previous silent behavior.
   * - `"throw"`: reject with `MISSING_TENANT_CONTEXT` — symmetrical with the
   *   existing INSERT behavior. Recommended for production.
   * - `"allow"`: execute unfiltered silently (explicitly sanctioned).
   *
   * The policy never applies to explicit escape hatches:
   * `MetadataContext.runUnscoped()`, an explicit
   * `MetadataContext.run("public", ...)` admin context, per-call
   * `withoutTenantScope`, and `@NonTenantEntity()` entities.
   *
   * The default will change to `"throw"` in the next major version.
   *
   * @default "warn"
   */
  tenantOnMissingContext?: "throw" | "warn" | "allow";

  /**
   * Resolver for the `"database"` tenant strategy.
   *
   * Called by `TenantConnectionRouter` the first time a tenant id is seen.
   * Return value:
   * - `string`: name of a connection that has already been registered with
   *   `DatabaseClient.connect(opts, name)`.
   * - `DatabaseClientOptions`: full options for a brand-new pool. The router
   *   will call `DatabaseClient.connect()` and `EntityManager.register()`
   *   automatically. The `entities` field of the returned options is ignored —
   *   the router reuses the entities passed to the parent `register()` call
   *   to keep schemas in sync.
   *
   * Mutually compatible with `tenantDatabaseMap` (the map is checked first;
   * the resolver is the fallback).
   */
  tenantDatabaseResolver?: (
    tenantId: string,
  ) =>
    | string
    | DatabaseClientOptions
    | Promise<string | DatabaseClientOptions>;

  /**
   * Static tenant→connection mapping for the `"database"` tenant strategy.
   * Use for known-at-boot tenant lists. Each connection name listed here must
   * have been registered with `DatabaseClient.connect(opts, name)` before any
   * query runs under that tenant context.
   */
  tenantDatabaseMap?: Record<string, string>;

  /**
   * Tenants that should be eagerly provisioned at `register()` time for the
   * `"database"` strategy. Each tenant id is resolved through
   * `tenantDatabaseResolver` (or `tenantDatabaseMap`) and synchronously
   * connected + synchronized so no first-request latency hits production.
   */
  eagerProvisionTenants?: string[];

  /**
   * Behavior when a query is issued outside any `MetadataContext.run()` block
   * under the `"database"` strategy.
   * - "default" (default): use the EntityManager that was passed to
   *   `MultiTenantEntityManager.register()` (admin / public DB).
   * - "throw": reject with `MISSING_TENANT_CONTEXT`. Use this in
   *   per-request HTTP services to catch routing bugs early.
   */
  publicTenantBehavior?: "default" | "throw";

  /**
   * Idle TTL (ms) for tenant pools under the `"database"` strategy. After this
   * many milliseconds without a query, the pool is closed and removed from the
   * router. Subsequent queries re-resolve through the resolver.
   * Set to 0 (default) to disable idle eviction.
   */
  tenantConnectionTtlMs?: number;

  /**
   * Plugins to install on the EntityManager after registration.
   * Plugins are installed in array order; dependencies must come before dependents.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins?: StingerloomPlugin<any>[];

  /**
   * Override the detected database version.
   * Useful for testing version-specific DDL behavior without connecting to a specific DB version.
   * When set, the ORM uses this version instead of auto-detecting from the connected database.
   * @example "5.7.0", "13.0.0", "3.24.0"
   */
  versionOverride?: string;
}

/**
 * Options for server-based databases (MySQL, MariaDB, PostgreSQL).
 * Requires host, port, username, and password.
 */
export interface ServerDatabaseClientOptions extends BaseDatabaseClientOptions {
  /** Type of the database to connect to */
  type: "mysql" | "mariadb" | "postgres";

  /** Database server host address */
  host: string;

  /** Port number for the database connection */
  port: number;

  /** Username for database authentication */
  username: string;

  /** Password for database authentication */
  password: string;

  /**
   * SSL/TLS encryption for the database connection.
   * - `true`: Enable SSL with default options (rejectUnauthorized: true)
   * - `SslOptions`: Enable SSL with custom certificate/key configuration
   * - `undefined` (default): No SSL (plaintext connection)
   *
   * @example
   * // Simple SSL (e.g., cloud-managed DB with public CA)
   * ssl: true
   *
   * @example
   * // Custom CA certificate
   * ssl: { ca: fs.readFileSync('/path/to/ca.pem', 'utf8') }
   *
   * @example
   * // Mutual TLS (mTLS)
   * ssl: { ca: caCert, cert: clientCert, key: clientKey }
   */
  ssl?: boolean | SslOptions;
}

/**
 * Options for SQLite database.
 * Only requires the database file path (or ":memory:" for in-memory).
 * host, port, username, password are not needed.
 */
export interface SqliteDatabaseClientOptions extends BaseDatabaseClientOptions {
  /** Type of the database to connect to */
  type: "sqlite";

  /** Not required for SQLite. Ignored if provided. */
  host?: string;

  /** Not required for SQLite. Ignored if provided. */
  port?: number;

  /** Not required for SQLite. Ignored if provided. */
  username?: string;

  /** Not required for SQLite. Ignored if provided. */
  password?: string;
}

/**
 * Configuration options for database client connection.
 * For SQLite, only `type` and `database` are required.
 * For MySQL/MariaDB/PostgreSQL, `host`, `port`, `username`, and `password` are also required.
 */
export type DatabaseClientOptions =
  | ServerDatabaseClientOptions
  | SqliteDatabaseClientOptions;

/**
 * Detailed query logging and diagnostics options.
 */
export interface LoggingOptions {
  /** Enable SQL query logging. */
  queries?: boolean;

  /** Emit a slow-query warning for queries exceeding this threshold (ms). */
  slowQueryMs?: number;

  /** Enable N+1 query detection warnings. */
  nPlusOne?: boolean;

  /**
   * Whether QueryTracker is enabled. When false, query tracking is fully disabled.
   * Set to false in production to eliminate overhead.
   * @default true (when nPlusOne or slowQueryMs is set)
   */
  enableQueryTracking?: boolean;

  /**
   * QueryTracker maximum log entries. Uses a ring buffer; older entries are evicted first on overflow.
   * @default 1000
   */
  maxLogEntries?: number;

  /**
   * QueryTracker log-eviction TTL (ms).
   * When set, each track() call removes entries older than this.
   */
  ttlMs?: number;
}

/**
 * Database types the ORM can connect to. Internal — the barrels do not
 * re-export it; `src/migration/cli-config.ts` reads it so the CLI can name the
 * supported types before a connection is attempted.
 */
export const VALID_DB_TYPES: readonly string[] = [
  "mysql",
  "mariadb",
  "postgres",
  "sqlite",
];

/**
 * Validates DatabaseClientOptions at runtime.
 * Throws OrmError with INVALID_CONFIG code if validation fails.
 */
export function validateDatabaseClientOptions(
  options: DatabaseClientOptions,
): void {
  const errors: string[] = [];

  // type
  if (!options.type) {
    errors.push("'type' is required.");
  } else if (!VALID_DB_TYPES.includes(options.type)) {
    errors.push(
      `'type' must be one of ${VALID_DB_TYPES.join(", ")}, got '${options.type}'.`,
    );
  }

  // database
  if (!options.database && options.database !== "") {
    errors.push("'database' is required.");
  } else if (typeof options.database !== "string") {
    errors.push(
      `'database' must be a string, got ${typeof options.database}.`,
    );
  }

  // Server-specific fields
  if (
    options.type === "mysql" ||
    options.type === "mariadb" ||
    options.type === "postgres"
  ) {
    // An empty database name is never valid for a server database. The generic
    // `database` check above intentionally accepts "" (SQLite treats it as an
    // anonymous temporary database), so reject it explicitly here.
    if (options.database === "") {
      errors.push(`'database' must not be empty for ${options.type}.`);
    }

    if (!options.host) {
      errors.push(`'host' is required for ${options.type}.`);
    } else if (typeof options.host !== "string") {
      errors.push(
        `'host' must be a string, got ${typeof options.host}.`,
      );
    }

    if (options.port === undefined || options.port === null) {
      errors.push(`'port' is required for ${options.type}.`);
    } else if (typeof options.port !== "number" || !Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
      errors.push(
        `'port' must be an integer between 1 and 65535, got ${JSON.stringify(options.port)}.`,
      );
    }

    if (options.username === undefined || options.username === null) {
      errors.push(`'username' is required for ${options.type}.`);
    } else if (typeof options.username !== "string") {
      errors.push(
        `'username' must be a string, got ${typeof options.username}.`,
      );
    }

    if (options.password === undefined || options.password === null) {
      errors.push(`'password' is required for ${options.type}.`);
    } else if (typeof options.password !== "string") {
      errors.push(
        `'password' must be a string, got ${typeof options.password}.`,
      );
    }
  }

  // entities
  if (!options.entities) {
    errors.push("'entities' is required.");
  } else if (!Array.isArray(options.entities)) {
    errors.push("'entities' must be an array.");
  }

  // queryTimeout
  if (
    options.queryTimeout !== undefined &&
    (typeof options.queryTimeout !== "number" || options.queryTimeout < 0)
  ) {
    errors.push(
      `'queryTimeout' must be a non-negative number, got ${JSON.stringify(options.queryTimeout)}.`,
    );
  }

  // pool
  if (options.pool) {
    if (options.pool.max !== undefined && (typeof options.pool.max !== "number" || options.pool.max < 1)) {
      errors.push(`'pool.max' must be a positive number, got ${JSON.stringify(options.pool.max)}.`);
    }
    if (options.pool.min !== undefined && (typeof options.pool.min !== "number" || options.pool.min < 0)) {
      errors.push(`'pool.min' must be a non-negative number, got ${JSON.stringify(options.pool.min)}.`);
    }
    if (options.pool.max !== undefined && options.pool.min !== undefined && options.pool.min > options.pool.max) {
      errors.push(`'pool.min' (${options.pool.min}) cannot exceed 'pool.max' (${options.pool.max}).`);
    }
  }

  // retry
  if (options.retry) {
    if (typeof options.retry.maxAttempts !== "number" || options.retry.maxAttempts < 1) {
      errors.push(`'retry.maxAttempts' must be a positive number, got ${JSON.stringify(options.retry.maxAttempts)}.`);
    }
    if (typeof options.retry.backoffMs !== "number" || options.retry.backoffMs < 0) {
      errors.push(`'retry.backoffMs' must be a non-negative number, got ${JSON.stringify(options.retry.backoffMs)}.`);
    }
  }

  if (errors.length > 0) {
    throw new OrmError(
      OrmErrorCode.INVALID_CONFIG,
      `Invalid database configuration:\n  - ${errors.join("\n  - ")}`,
      "Check your DatabaseClientOptions and fix the listed issues.",
    );
  }
}

/**
 * Bare-form synchronize values (legacy shape).
 */
export type SynchronizeMode = boolean | "safe" | "dry-run";

/**
 * Options-object form of the `synchronize` field. Separates the resilience,
 * destructive-change safety, and DDL visibility concerns that the bare form
 * coupled together.
 */
export interface SynchronizeOptions {
  /**
   * The base synchronization mode.
   * - `true`: Full sync (create / add / alter / drop / rename).
   * - `"safe"`: Create tables and add columns only — never drop/alter/rename.
   * - `"dry-run"`: Log DDL that would run, but never execute.
   */
  mode: true | "safe" | "dry-run";

  /**
   * When `false`, the first DDL failure aborts `registerEntities()` by
   * rethrowing the error. When `true`, failures are downgraded to warnings and
   * registration continues — matches the historical behavior.
   * @default true
   */
  continueOnError?: boolean;

  /**
   * When `true`, destructive operations throw before executing:
   * DROP COLUMN, DROP TABLE, and narrowing ALTER (e.g. `varchar(255) → int`).
   * Use this to opt production into a hard failure instead of silently
   * applying destructive DDL.
   * @default false
   */
  failOnDestructiveChange?: boolean;

  /**
   * When `true`, every emitted DDL statement is logged at info level — even
   * statements that succeed silently today (add column, create index, etc.).
   * @default false
   */
  logDDL?: boolean;
}

/**
 * Union of every accepted value for the `synchronize` option.
 */
export type SynchronizeOption = SynchronizeMode | SynchronizeOptions;

/**
 * Internal normalized representation. Every code path inside the ORM should
 * consume this shape instead of branching on the original union — the
 * normalizer in `normalizeSynchronizePolicy()` is the single point of truth.
 */
export interface SynchronizePolicy {
  /**
   * `false` means no synchronization runs at all (registrar exits early).
   * Otherwise carries the active mode.
   */
  mode: false | true | "safe" | "dry-run";
  continueOnError: boolean;
  failOnDestructiveChange: boolean;
  logDDL: boolean;
}

/**
 * Maps an arbitrary `synchronize` value to the normalized policy.
 *
 * Defaults applied for the bare forms preserve the historical behavior:
 *   - `continueOnError: true` (existing try/catch-warn semantics)
 *   - `failOnDestructiveChange: false` (drops just ran)
 *   - `logDDL: false` (only some paths logged)
 *
 * When an options object is passed, omitted flags fall back to the same
 * historical defaults so callers only opt into the new behavior they want.
 */
export function normalizeSynchronizePolicy(
  value: SynchronizeOption | undefined,
): SynchronizePolicy {
  if (value === undefined || value === false) {
    return {
      mode: false,
      continueOnError: true,
      failOnDestructiveChange: false,
      logDDL: false,
    };
  }

  if (value === true || value === "safe" || value === "dry-run") {
    return {
      mode: value,
      continueOnError: true,
      failOnDestructiveChange: false,
      logDDL: false,
    };
  }

  // Options-object form
  return {
    mode: value.mode,
    continueOnError: value.continueOnError ?? true,
    failOnDestructiveChange: value.failOnDestructiveChange ?? false,
    logDDL: value.logDDL ?? false,
  };
}

/**
 * Connection retry configuration with exponential backoff.
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts.
   * @default 3
   */
  maxAttempts: number;

  /**
   * Base delay in milliseconds between retries.
   * Actual delay = backoffMs * 2^(attempt-1)
   * @default 1000
   */
  backoffMs: number;
}
