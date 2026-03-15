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

  async connect(options: DatabaseClientOptions): Promise<void> {
    try {
      let PgPool: typeof import("pg").Pool;
      try {
        PgPool = require("pg").Pool;
      } catch {
        throw new Error(
          "pg 패키지가 필요합니다. npm install pg",
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
      this.pool.on("connect", (client) => {
        client.query(`SET search_path TO ${this.schema}`);
      });
    } catch (e: unknown) {
      throw new Error(`PostgreSQL 연결에 실패했습니다. ${e}`);
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

    const client = connection as PoolClient;
    if (!client) {
      throw new ConnectionNotFound();
    }

    await client.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
  }

  async startTransaction(
    connection: any,
    level: TRANSACTION_ISOLATION_LEVEL = "READ COMMITTED",
  ): Promise<void> {
    const client = connection as PoolClient;
    if (!client) {
      throw new ConnectionNotFound();
    }

    await client.query("BEGIN");
    await this.setTransactionIsolationLevel(client, level);

    // 멀티테넌시: 트랜잭션 스코프 search_path 설정
    // SET LOCAL은 현재 트랜잭션에만 적용되고 COMMIT/ROLLBACK 시 자동 복원
    const tenant = MetadataContext.getCurrentTenant();
    const schema = tenant !== "public" ? tenant : this.schema;
    const escaped = schema.replace(/"/g, '""');
    await client.query(`SET LOCAL search_path TO "${escaped}"`);
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
