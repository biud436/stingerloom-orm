import { IDatabaseType, AnyEntity } from "../dialects/mysql/MySqlConnector";

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
   * If set to true, tables will be automatically created if they don't exist.
   */
  synchronize?: boolean;

  /** Enable/disable query logging */
  logging?: boolean;

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
   * Connection pool configuration.
   * MySQL과 PostgreSQL에서 적용됩니다.
   * SQLite는 파일 기반 단일 연결이므로 이 옵션이 무시됩니다.
   */
  pool?: PoolOptions;
}
