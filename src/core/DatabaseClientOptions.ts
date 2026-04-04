import { IDatabaseType, AnyEntity } from "../dialects/mysql/MySqlConnector";
import { ReplicationConfig } from "../dialects/ReplicationRouter";
import { NamingStrategy } from "./generators/NamingStrategy";
import { StingerloomPlugin } from "./plugin/StingerloomPlugin";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * Connection pool configuration options.
 * MySQL과 PostgreSQL에서 공통으로 사용됩니다.
 * SQLite는 파일 기반이므로 단일 연결을 유지하며 풀 설정이 무시됩니다.
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
 * Common options shared by all database types.
 */
interface BaseDatabaseClientOptions {
  /** Name of the database (or file path for SQLite) to connect to */
  database: string;

  /**
   * Enable/disable schema synchronization.
   * - `true`: Full synchronization — creates tables, adds/drops columns as needed.
   * - `'safe'`: Safe mode — creates tables and adds columns, but never drops columns or tables.
   * - `'dry-run'`: Preview mode — logs DDL statements that would be executed without applying them.
   * - `false` (default): No synchronization.
   */
  synchronize?: boolean | "safe" | "dry-run";

  /**
   * Enable/disable query logging and diagnostics.
   * - `true`: 기본 쿼리 로깅만 활성화
   * - `LoggingOptions`: 상세 옵션 (슬로우 쿼리, N+1 감지 등)
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
   * @deprecated Use `pool.max` instead. This is kept for backward compatibility.
   */
  connectionLimit?: number;

  /** MySQL Only: The charset for the connection */
  charset?: string;

  /**
   * PostgreSQL Only: The schema to use.
   * PostgreSQL은 database → schema → table 3계층 구조를 가집니다.
   * 지정하지 않으면 기본값 'public'을 사용합니다.
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
   * MySQL과 PostgreSQL에서 적용됩니다.
   * SQLite는 파일 기반 단일 연결이므로 이 옵션이 무시됩니다.
   */
  pool?: PoolOptions;

  /**
   * Connection retry configuration with exponential backoff.
   * 연결 실패 시 지수 백오프로 재시도합니다.
   */
  retry?: RetryOptions;

  /**
   * Read replica (읽기/쓰기 분리) 설정.
   * 설정 시 읽기 쿼리는 slave로, 쓰기 쿼리는 master로 라우팅됩니다.
   * slave 실패 시 master로 자동 fallback됩니다.
   */
  replication?: ReplicationConfig;

  /**
   * Custom naming strategy for FK constraints, indexes, and unique indexes.
   * If not provided, DefaultNamingStrategy is used (SHA1-based FK names, convention-based index names).
   */
  namingStrategy?: NamingStrategy;

  /**
   * Multi-tenant query strategy for PostgreSQL.
   * - "search_path" (default): Uses SET LOCAL search_path inside a transaction for tenant reads.
   *   Safe for all cases but requires 5 round-trips per tenant read.
   * - "schema_qualified": Uses schema-qualified table names (e.g. "tenant_a"."users").
   *   Allows single-round-trip tenant reads without transactions.
   *
   * This option only affects PostgreSQL tenant reads. Non-tenant reads, writes,
   * MySQL, and SQLite are unaffected.
   */
  tenantStrategy?: "search_path" | "schema_qualified";

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
 * 쿼리 로깅 및 진단 상세 옵션.
 */
export interface LoggingOptions {
  /** 쿼리 SQL 로깅 활성화 */
  queries?: boolean;

  /** 이 값(ms)을 초과하는 쿼리에 대해 슬로우 쿼리 경고를 출력합니다 */
  slowQueryMs?: number;

  /** N+1 쿼리 감지 경고를 활성화합니다 */
  nPlusOne?: boolean;

  /**
   * QueryTracker 활성화 여부. false이면 쿼리 추적을 완전히 비활성화합니다.
   * 프로덕션 환경에서 오버헤드를 제거하려면 false로 설정하세요.
   * @default true (nPlusOne 또는 slowQueryMs 설정 시)
   */
  enableQueryTracking?: boolean;

  /**
   * QueryTracker 최대 로그 보관 수. Ring buffer 방식으로 초과 시 가장 오래된 항목부터 제거됩니다.
   * @default 1000
   */
  maxLogEntries?: number;

  /**
   * QueryTracker 로그 항목 자동 삭제 TTL (ms).
   * 설정 시 track() 호출마다 이 시간보다 오래된 항목을 제거합니다.
   */
  ttlMs?: number;
}

const VALID_DB_TYPES: readonly string[] = [
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
