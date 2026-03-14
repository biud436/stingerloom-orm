import { IDatabaseType, AnyEntity } from "../dialects/mysql/MySqlConnector";
import { ReplicationConfig } from "../dialects/ReplicationRouter";
import { NamingStrategy } from "./generators/NamingStrategy";

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
}

/**
 * Configuration options for database client connection.
 */
export interface DatabaseClientOptions {
  /** Type of the database to connect to */
  type: IDatabaseType;

  /** Database server host address */
  host: string;

  /** Port number for the database connection */
  port: number;

  /** Username for database authentication */
  username: string;

  /** Password for database authentication */
  password: string;

  /** Name of the database to connect to */
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

  /** Array of entity classes that will be used by the connection */
  entities: AnyEntity[];

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
}

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
