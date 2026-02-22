/* eslint-disable @typescript-eslint/no-explicit-any */
import mssql from "mssql";
import { Sql } from "sql-template-tag";
import { Logger } from "../../utils/Logger";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { ConnectionNotFound } from "./ConnectionNotFound";
import { PoolNotFound } from "./PoolNotFound";
import { DatabaseClientOptions } from "../../core/DatabaseClientOptions";
import { IConnector } from "../../core/IConnector";

/**
 * MSSQL isolation level 문자열을 mssql 패키지의 IsolationLevel 상수로 변환합니다.
 */
function toMssqlIsolationLevel(
  level: TRANSACTION_ISOLATION_LEVEL,
): mssql.IIsolationLevel {
  switch (level) {
    case "READ UNCOMMITTED":
      return mssql.ISOLATION_LEVEL.READ_UNCOMMITTED;
    case "READ COMMITTED":
      return mssql.ISOLATION_LEVEL.READ_COMMITTED;
    case "REPEATABLE READ":
      return mssql.ISOLATION_LEVEL.REPEATABLE_READ;
    case "SERIALIZABLE":
      return mssql.ISOLATION_LEVEL.SERIALIZABLE;
    default:
      return mssql.ISOLATION_LEVEL.READ_COMMITTED;
  }
}

/**
 * MSSQL Connector implementation using the `mssql` package.
 * Uses connection pooling via mssql.ConnectionPool.
 *
 * MSSQL uses @param0, @param1 style parameter placeholders.
 * sql-template-tag의 $1, $2 형식을 @param0, @param1 형식으로 변환합니다.
 */
export class MssqlConnector extends IConnector {
  private pool?: mssql.ConnectionPool;
  private isDebug = false;
  private readonly logger = new Logger("MssqlConnector");

  async connect(options: DatabaseClientOptions): Promise<void> {
    try {
      const {
        host,
        username,
        password,
        database,
        port,
        logging,
        pool: poolOptions,
      } = options;

      const config: mssql.config = {
        server: host,
        user: username,
        password,
        database,
        port,
        options: {
          encrypt: false,
          trustServerCertificate: true,
        },
        pool: {
          max: poolOptions?.max ?? 10,
          min: poolOptions?.min ?? 0,
          idleTimeoutMillis: poolOptions?.idleTimeoutMs ?? 10000,
          acquireTimeoutMillis: poolOptions?.acquireTimeoutMs ?? 30000,
        },
      };

      this.isDebug = !!logging;
      this.pool = new mssql.ConnectionPool(config);
      await this.pool.connect();
    } catch (e: unknown) {
      throw new Error(`MSSQL connection failed. ${e}`);
    }
  }

  /**
   * 커넥션 풀에서 Request 객체를 생성하기 위해 풀 자체를 반환합니다.
   */
  async getConnection(): Promise<mssql.ConnectionPool> {
    if (!this.pool) {
      throw new PoolNotFound();
    }

    return this.pool;
  }

  async runTestSql(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.query("SELECT 1 AS result");
  }

  async query(sql: string, connection?: any): Promise<any>;
  async query<T = any>(sql: Sql, connection?: any): Promise<T>;
  async query<T = any>(rawSql: Sql | string, connection?: any): Promise<T> {
    const pool = connection ?? this.pool;
    if (!pool) {
      throw new ConnectionNotFound();
    }

    if (typeof rawSql === "string") {
      if (this.isDebug) {
        this.logger.info(`Query: ${rawSql}`);
      }

      // string 쿼리는 Request를 통해 바로 실행
      const request: mssql.Request =
        pool instanceof mssql.Transaction
          ? new mssql.Request(pool)
          : pool.request();

      const result = await request.query(rawSql);

      if (connection) {
        return {
          results: result.recordset ?? result.rowsAffected,
          fields: result.output,
        } as T;
      }
      return (result.recordset ?? result.rowsAffected) as T;
    } else {
      const { sql, values } = rawSql;

      if (this.isDebug) {
        this.logger.info(`Query: ${sql}, # ${JSON.stringify(values)}`);
      }

      // sql-template-tag: $1, $2, ... → @param0, @param1, ...
      const mssqlSql = sql.replace(/\$(\d+)/g, (_match, num) => {
        return `@param${parseInt(num, 10) - 1}`;
      });

      const request: mssql.Request =
        pool instanceof mssql.Transaction
          ? new mssql.Request(pool)
          : pool.request();

      if (values && values.length > 0) {
        values.forEach((value: any, index: number) => {
          request.input(`param${index}`, value);
        });
      }

      const result = await request.query(mssqlSql);

      if (connection) {
        return {
          results: result.recordset ?? result.rowsAffected,
          fields: result.output,
        } as T;
      }
      return (result.recordset ?? result.rowsAffected) as T;
    }
  }

  async close(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.pool.close();
    this.pool = undefined;
  }

  async setTransactionIsolationLevel(
    _connection: any,
    _level: TRANSACTION_ISOLATION_LEVEL,
  ): Promise<void> {
    // MSSQL의 격리 수준은 트랜잭션 시작 시 설정됩니다.
  }

  async startTransaction(
    connection: any,
    level: TRANSACTION_ISOLATION_LEVEL = "READ COMMITTED",
  ): Promise<void> {
    const pool = connection as mssql.ConnectionPool;
    if (!pool) {
      throw new ConnectionNotFound();
    }

    const transaction = new mssql.Transaction(pool);
    await transaction.begin(toMssqlIsolationLevel(level));

    // 트랜잭션 객체를 pool 객체에 임시 저장
    (pool as any).__activeTransaction = transaction;
  }

  async rollback(connection: any): Promise<void> {
    const pool = connection as mssql.ConnectionPool;
    if (!pool) {
      throw new ConnectionNotFound();
    }

    const transaction = (pool as any).__activeTransaction as
      | mssql.Transaction
      | undefined;
    if (transaction) {
      await transaction.rollback();
      (pool as any).__activeTransaction = undefined;
    }
  }

  async commit(connection: any): Promise<void> {
    const pool = connection as mssql.ConnectionPool;
    if (!pool) {
      throw new ConnectionNotFound();
    }

    const transaction = (pool as any).__activeTransaction as
      | mssql.Transaction
      | undefined;
    if (transaction) {
      try {
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        (pool as any).__activeTransaction = undefined;
      }
    }
  }
}
