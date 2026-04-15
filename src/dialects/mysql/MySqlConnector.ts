/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Pool, PoolConnection } from "mysql2";
import sql, { Sql } from "sql-template-tag";
import { Logger } from "../../utils/Logger";
import { Connection } from "./Connection";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { ConnectionNotFound } from "./ConnectionNotFound";
import { PoolNotFound } from "./PoolNotFound";
import { DatabaseClientOptions } from "../../core/DatabaseClientOptions";
import { IConnector } from "../../core/IConnector";
import { IConnection } from "../IConnection";
import { MysqlConnection } from "./MysqlConnection";
import { validateIsolationLevel } from "../../utils/validateIsolationLevel";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { DbVersion } from "../DbVersion";
export type AnyEntity = any;
export type IDatabaseType = "mysql" | "mariadb" | "postgres" | "sqlite";

export class MySqlConnector extends IConnector {
  pool?: Pool;
  private isDebug = false;
  private validateOnBorrow = false;
  private readonly logger = new Logger("MySqlConnector");
  private _dbVersion: DbVersion = DbVersion.UNKNOWN;

  async connect(options: DatabaseClientOptions): Promise<void> {
    try {
      let mysql: typeof import("mysql2");
      try {
        mysql = require("mysql2");
      } catch {
        throw new OrmError(
          OrmErrorCode.MISSING_DEPENDENCY,
          "mysql2 패키지가 필요합니다.",
          "Run: npm install mysql2",
        );
      }

      const {
        host,
        username,
        password,
        database,
        port,
        datesStrings,
        connectionLimit,
        charset,
        logging,
        pool: poolOptions,
      } = options;

      // pool.max > connectionLimit > 기본값(10) 우선순위로 적용
      const maxConnections = poolOptions?.max ?? connectionLimit ?? 10;

      // SSL/TLS 옵션 변환
      const ssl = "ssl" in options ? options.ssl : undefined;
      let sslConfig: any = undefined;
      if (ssl === true) {
        sslConfig = { rejectUnauthorized: true };
      } else if (ssl && typeof ssl === "object") {
        sslConfig = { ...ssl };
      }

      const pool = mysql.createPool({
        host,
        user: username,
        password,
        database,
        port,
        dateStrings: datesStrings,
        connectionLimit: maxConnections,
        charset: charset ?? "utf8mb4",
        ...(sslConfig ? { ssl: sslConfig } : {}),
      });

      this.isDebug = !!logging;
      this.validateOnBorrow = poolOptions?.validateOnBorrow ?? false;

      this.pool = pool;

      // Detect database version
      try {
        if (options.versionOverride) {
          this._dbVersion = DbVersion.parse(options.versionOverride);
        } else {
          const rows: any[] = await this.query("SELECT VERSION() as v");
          this._dbVersion = DbVersion.parse(rows[0]?.v ?? "unknown");
        }
      } catch {
        // Version detection failure is non-fatal — default to UNKNOWN
        this._dbVersion = DbVersion.UNKNOWN;
      }
    } catch (e: unknown) {
      if (e instanceof OrmError) throw e;
      throw new OrmError(
        OrmErrorCode.CONNECTION_FAILED,
        `MySQL 연결에 실패했습니다. ${e}`,
        "Check that the MySQL server is running and reachable",
      );
    }
  }

  override getVersion(): DbVersion {
    return this._dbVersion;
  }

  /**
   * 풀에서 raw connection을 하나 가져옵니다.
   */
  private acquireRawConnection(): Promise<PoolConnection> {
    if (!this.pool) {
      throw new PoolNotFound();
    }

    return new Promise((resolve, reject) => {
      this.pool?.getConnection((error, connection) => {
        if (error) {
          return reject(error);
        }

        resolve(connection);
      });
    });
  }

  /**
   * mysql2 네이티브 COM_PING으로 연결 상태를 확인합니다.
   */
  private pingConnection(connection: PoolConnection): Promise<boolean> {
    return new Promise((resolve) => {
      connection.ping((err) => {
        resolve(!err);
      });
    });
  }

  /**
   * 트랜잭션 처리를 위해 커넥션 풀에서 커넥션을 하나 가져옵니다.
   * validateOnBorrow가 활성화되면 ping으로 연결 상태를 확인하고,
   * stale 연결은 폐기 후 새 연결로 교체합니다.
   */
  async getConnection(): Promise<PoolConnection> {
    const conn = await this.acquireRawConnection();

    if (!this.validateOnBorrow) {
      return conn;
    }

    if (await this.pingConnection(conn)) {
      return conn;
    }

    // stale connection — destroy and retry once
    conn.destroy();

    const retryConn = await this.acquireRawConnection();

    if (await this.pingConnection(retryConn)) {
      return retryConn;
    }

    retryConn.destroy();
    throw new OrmError(
      OrmErrorCode.CONNECTION_FAILED,
      "Connection health check failed after retry",
      "Check that the database server is running and reachable",
    );
  }

  async acquireConnection(): Promise<IConnection<PoolConnection>> {
    const raw = await this.getConnection();
    return new MysqlConnection(raw);
  }

  async runTestSql(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.query(sql`SELECT 1 + 1`);
  }

  async query(sql: string, connection?: Connection): Promise<any>;
  async query({ sql, values }: Sql, connection?: Connection): Promise<any>;
  async query(rawSql: Sql | string, connection?: Connection): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.pool) {
        return;
      }

      const qb = connection ? connection : this.pool;

      if (typeof rawSql === "string") {
        qb.query(rawSql, (error, results, fields) => {
          if (error) {
            return reject(error);
          }

          if (this.isDebug) {
            this.logger.info(`Query: ${rawSql}`);
          }

          if (connection) {
            resolve({ results, fields, error });
          } else {
            resolve(results);
          }
        });
      } else {
        const { sql, values } = rawSql;

        // Parameterized DML goes through mysql2's binary protocol
        // (COM_STMT_PREPARE + COM_STMT_EXECUTE) via `execute()`. The server
        // parses each distinct SQL text once and caches the resulting
        // prepared statement; subsequent calls with the same text reuse it
        // with a `maxPreparedStatements`-bounded LRU per connection (mysql2
        // default ≈ 16,000).
        //
        // Non-DML parameterized SQL (SHOW, DESCRIBE, KILL, DDL containing
        // placeholders, etc.) stays on the text-protocol `query()` path.
        // MariaDB in particular rejects prepare for SHOW — e.g. `SHOW
        // TABLES LIKE ?` used by hasTable() produces "syntax error near
        // '?'" under COM_STMT_PREPARE even though it works fine via
        // COM_QUERY. We detect this by prefix; safer than a try-execute /
        // catch-parse-error fallback that would double-round-trip every
        // failed prep.
        const useExecute = MySqlConnector.shouldUseExecute(sql);
        const method = useExecute ? qb.execute.bind(qb) : qb.query.bind(qb);
        // mysql2's execute() is stricter than query(): `undefined` in the
        // bind-parameter array throws "Bind parameters must not contain
        // undefined" rather than being silently coerced to SQL NULL. That
        // coercion is what sql-template-tag + query() gave us historically,
        // so we preserve the behavior at the execute() boundary.
        const boundValues = useExecute
          ? MySqlConnector.normalizeBindValues(values)
          : values;

        method(sql, boundValues, (error: any, results: any, fields: any) => {
          if (error) {
            return reject(error);
          }

          if (this.isDebug) {
            this.logger.info(`Query: ${sql}, # ${JSON.stringify(values)}`);
            this.logger.info(`Results: ${results}`);
            this.logger.info(`Error: ${JSON.stringify(error)}`);
          }

          if (connection) {
            resolve({ results, fields, error });
          } else {
            resolve(results);
          }
        });
      }
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.pool) {
        return;
      }

      this.pool.end((error) => {
        if (error) {
          return reject(error);
        }

        resolve();
      });
    });
  }

  /**
   * DML keywords that are safe to send through the prepared-statement
   * protocol on both MySQL and MariaDB. Anything else (SHOW, DESCRIBE,
   * EXPLAIN, DDL, KILL, CALL with OUT params, …) falls back to COM_QUERY.
   *
   * Leading whitespace and a leading block/line comment are tolerated so
   * sql-template-tag output like `   /* ... *\/ SELECT ...` still matches.
   */
  private static readonly DML_PREFIX_RE =
    /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|VALUES)\b/i;

  /** @internal Exposed for unit testing. */
  static shouldUseExecute(sqlText: string): boolean {
    return MySqlConnector.DML_PREFIX_RE.test(sqlText);
  }

  /**
   * @internal Replace `undefined` values (at top level only) with `null`.
   * mysql2's text protocol silently coerces undefined → NULL, but its
   * binary/prepared-statement protocol throws. We match the historical
   * behavior so flipping to execute() doesn't regress callers.
   */
  static normalizeBindValues(values: readonly any[]): any[] {
    let hasUndefined = false;
    for (const v of values) {
      if (v === undefined) {
        hasUndefined = true;
        break;
      }
    }
    if (!hasUndefined) return values as any[];
    return values.map((v) => (v === undefined ? null : v));
  }

  private static readonly ISOLATION_LEVEL_SQL: Record<string, string> = {
    "READ UNCOMMITTED": "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED",
    "READ COMMITTED": "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    "REPEATABLE READ": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    "SERIALIZABLE": "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
  };

  async setTransactionIsolationLevel(
    connection: Connection,
    level: TRANSACTION_ISOLATION_LEVEL,
  ): Promise<void> {
    validateIsolationLevel(level);

    const safeSql = MySqlConnector.ISOLATION_LEVEL_SQL[level];
    if (!safeSql) {
      throw new Error(`Invalid isolation level: ${level}`);
    }

    return new Promise((resolve, reject) => {
      if (!connection) {
        return reject(new ConnectionNotFound());
      }

      /**
       * 커넥션에 설정된 트랜잭션 격리 수준은 해당 커넥션에서 수행되는 모든 트랜잭션에만 적용됨
       */
      connection.query(safeSql, (error) => {
        if (error) {
          return reject(error);
        }

        resolve();
      });
    });
  }

  // MySQL 기본 격리 수준 — 동일하면 SET TRANSACTION 생략 (#212)
  private static readonly DEFAULT_ISOLATION: TRANSACTION_ISOLATION_LEVEL = "REPEATABLE READ";

  async startTransaction(
    connection: Connection,
    level: TRANSACTION_ISOLATION_LEVEL = "REPEATABLE READ",
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!connection) {
        return reject(new ConnectionNotFound());
      }

      const beginTx = () => {
        connection.beginTransaction((error) => {
          if (error) {
            return reject(error);
          }
          resolve();
        });
      };

      // #212: 기본 격리 수준이면 SET TRANSACTION 생략
      if (level !== MySqlConnector.DEFAULT_ISOLATION) {
        this.setTransactionIsolationLevel(connection, level)
          .then(beginTx)
          .catch(reject);
      } else {
        beginTx();
      }
    });
  }

  async rollback(connection: Connection): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!connection) {
        return reject(new ConnectionNotFound());
      }

      connection.rollback((rollbackErr) => {
        if (rollbackErr) {
          // Rollback failed — destroy connection instead of returning to pool
          connection.destroy();
          reject(rollbackErr);
          return;
        }
        connection.release();
        resolve();
      });
    });
  }

  async commit(connection: Connection): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!connection) {
        return reject(new ConnectionNotFound());
      }

      connection.commit((error) => {
        if (error) {
          connection.rollback((rollbackErr) => {
            if (rollbackErr) {
              // Both commit and rollback failed — destroy connection
              connection.destroy();
              reject(error);
              return;
            }
            connection.release();
            reject(error);
          });
          return;
        }

        connection.release();
        resolve();
      });
    });
  }
}
