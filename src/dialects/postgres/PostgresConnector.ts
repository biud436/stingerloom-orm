/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Pool, PoolClient } from "pg";
import { Sql } from "sql-template-tag";
import { Logger } from "../../utils/Logger";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { ConnectionNotFound } from "./ConnectionNotFound";
import { PoolNotFound } from "./PoolNotFound";
import { DatabaseClientOptions } from "../../core/DatabaseClientOptions";
import { IConnector } from "../../core/IConnector";
import { IConnection } from "../IConnection";
import { PostgresConnection } from "./PostgresConnection";
import { MetadataContext } from "../../metadata/MetadataContext";
import { validateIsolationLevel } from "../../utils/validateIsolationLevel";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

export class PostgresConnector extends IConnector {
  pool?: Pool;
  private isDebug = false;
  private schema = "public";
  private validateOnBorrow = false;
  private readonly logger = new Logger("PostgresConnector");

  private static readonly ISOLATION_LEVEL_SQL: Record<string, string> = {
    "READ UNCOMMITTED": "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED",
    "READ COMMITTED": "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    "REPEATABLE READ": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    "SERIALIZABLE": "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
  };

  /**
   * PostgreSQL 식별자 유효성 검증 (alphanumeric, underscore, dollar sign만 허용).
   * 유효하지 않은 문자가 포함되면 예외를 발생시킵니다.
   */
  private static validateIdentifier(name: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(name)) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        `Invalid identifier: "${name}". Only alphanumeric characters, underscores, and dollar signs are allowed.`,
        "Use a valid PostgreSQL identifier (alphanumeric + underscore)",
      );
    }
  }

  /**
   * 식별자를 큰따옴표로 감싸서 반환합니다 (PostgreSQL 표준).
   * 내부에 포함된 `"` 문자는 PostgreSQL 표준인 `""` 으로 이스케이프합니다.
   * 추가로 strict validation을 수행합니다.
   */
  private escapeIdentifier(name: string): string {
    PostgresConnector.validateIdentifier(name);
    return `"${name.replace(/"/g, '""')}"`;
  }

  async connect(options: DatabaseClientOptions): Promise<void> {
    try {
      let PgPool: typeof import("pg").Pool;
      try {
        PgPool = require("pg").Pool;
      } catch {
        throw new OrmError(
          OrmErrorCode.MISSING_DEPENDENCY,
          "pg 패키지가 필요합니다.",
          "Run: npm install pg",
        );
      }

      const { host, username, password, database, port, logging, pool: poolOptions } = options;

      this.schema = options.schema ?? "public";

      // pool.max > connectionLimit > 기본값(10) 우선순위로 적용
      const maxConnections = poolOptions?.max ?? options.connectionLimit ?? 10;

      const pool = new PgPool({
        host,
        user: username,
        password,
        database,
        port,
        max: maxConnections,
        min: poolOptions?.min ?? 0,
        connectionTimeoutMillis: poolOptions?.acquireTimeoutMs ?? 30000,
        idleTimeoutMillis: poolOptions?.idleTimeoutMs ?? 10000,
      });

      this.isDebug = !!logging;
      this.validateOnBorrow = poolOptions?.validateOnBorrow ?? false;
      this.pool = pool;

      // 기본 search_path를 설정합니다.
      // 이후 풀에서 가져오는 모든 커넥션에 적용됩니다.
      const safeSchema = this.escapeIdentifier(this.schema);
      this.pool.on("connect", (client) => {
        client.query(`SET search_path TO ${safeSchema}`);
      });
    } catch (e: unknown) {
      if (e instanceof OrmError) throw e;
      throw new OrmError(
        OrmErrorCode.CONNECTION_FAILED,
        `PostgreSQL 연결에 실패했습니다. ${e}`,
        "Check that the PostgreSQL server is running and reachable",
      );
    }
  }

  /**
   * 풀에서 raw client를 하나 가져옵니다.
   */
  private async acquireRawConnection(): Promise<PoolClient> {
    if (!this.pool) {
      throw new PoolNotFound();
    }

    return this.pool.connect();
  }

  /**
   * SELECT 1으로 연결 상태를 확인합니다.
   */
  private async pingConnection(client: PoolClient): Promise<boolean> {
    try {
      await client.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 트랜잭션 처리를 위해 커넥션 풀에서 커넥션을 하나 가져옵니다.
   * validateOnBorrow가 활성화되면 SELECT 1로 연결 상태를 확인하고,
   * stale 연결은 폐기 후 새 연결로 교체합니다.
   */
  async getConnection(): Promise<PoolClient> {
    const client = await this.acquireRawConnection();

    if (!this.validateOnBorrow) {
      return client;
    }

    if (await this.pingConnection(client)) {
      return client;
    }

    // stale connection — destroy and retry once
    client.release(true);

    const retryClient = await this.acquireRawConnection();

    if (await this.pingConnection(retryClient)) {
      return retryClient;
    }

    retryClient.release(true);
    throw new OrmError(
      OrmErrorCode.CONNECTION_FAILED,
      "Connection health check failed after retry",
      "Check that the database server is running and reachable",
    );
  }

  async acquireConnection(): Promise<IConnection<PoolClient>> {
    const raw = await this.getConnection();
    return new PostgresConnection(raw);
  }

  async runTestSql(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.query("SELECT 1 + 1");
  }

  async query(sql: string, connection?: any): Promise<any>;
  async query<T = any>(sql: Sql, connection?: any): Promise<T>;
  async query<T = any>(rawSql: Sql | string, connection?: any): Promise<T> {
    if (!this.pool) {
      throw new PoolNotFound();
    }

    const client: Pool | PoolClient = connection ?? this.pool;

    if (typeof rawSql === "string") {
      if (this.isDebug) {
        this.logger.info(`Query: ${rawSql}`);
      }

      const result = await client.query(rawSql);

      if (connection) {
        return {
          results: result.rows,
          fields: result.fields,
          rowCount: result.rowCount,
          error: null,
        } as T;
      }

      return result.rows as T;
    } else {
      const { sql, values } = rawSql;

      if (this.isDebug) {
        this.logger.info(`Query: ${sql}, # ${JSON.stringify(values)}`);
      }

      // PostgreSQL은 $1, $2 형식의 파라미터를 사용합니다.
      // sql-template-tag는 ? 를 사용하므로 변환이 필요합니다.
      let paramIndex = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);

      const result = await client.query(pgSql, values);

      if (this.isDebug) {
        this.logger.info(`Results: ${JSON.stringify(result.rows)}`);
      }

      if (connection) {
        return {
          results: result.rows,
          fields: result.fields,
          rowCount: result.rowCount,
          error: null,
        } as T;
      }

      return result.rows as T;
    }
  }

  async close(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.pool.end();
  }

  async setTransactionIsolationLevel(
    connection: any,
    level: TRANSACTION_ISOLATION_LEVEL,
  ): Promise<void> {
    validateIsolationLevel(level);

    const safeSql = PostgresConnector.ISOLATION_LEVEL_SQL[level];
    if (!safeSql) {
      throw new Error(`Invalid isolation level: ${level}`);
    }

    const client = connection as PoolClient;
    if (!client) {
      throw new ConnectionNotFound();
    }

    await client.query(safeSql);
  }

  // PostgreSQL 기본 격리 수준 — 동일하면 SET TRANSACTION 생략 (#212)
  private static readonly DEFAULT_ISOLATION: TRANSACTION_ISOLATION_LEVEL = "READ COMMITTED";

  async startTransaction(
    connection: any,
    level: TRANSACTION_ISOLATION_LEVEL = "READ COMMITTED",
  ): Promise<void> {
    const client = connection as PoolClient;
    if (!client) {
      throw new ConnectionNotFound();
    }

    await client.query("BEGIN");

    // #212: 기본 격리 수준이면 SET TRANSACTION 생략
    if (level !== PostgresConnector.DEFAULT_ISOLATION) {
      await this.setTransactionIsolationLevel(client, level);
    }

    // #213: 멀티테넌시 — public 스키마면 SET LOCAL 생략
    const tenant = MetadataContext.getCurrentTenant();
    const schema = tenant !== "public" ? tenant : this.schema;
    if (schema !== "public") {
      const safeSchema = this.escapeIdentifier(schema);
      await client.query(`SET LOCAL search_path TO ${safeSchema}`);
    }
  }

  async rollback(connection: any): Promise<void> {
    const client = connection as PoolClient;
    if (!client) {
      throw new ConnectionNotFound();
    }

    await client.query("ROLLBACK");
    client.release();
  }

  async commit(connection: any): Promise<void> {
    const client = connection as PoolClient;
    if (!client) {
      throw new ConnectionNotFound();
    }

    try {
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      client.release();
      throw error;
    }

    client.release();
  }
}
