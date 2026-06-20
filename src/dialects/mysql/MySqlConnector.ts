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

      // Apply in priority order: pool.max > connectionLimit > default (10)
      const maxConnections = poolOptions?.max ?? connectionLimit ?? 10;

      // Convert SSL/TLS options
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
   * Acquires a raw connection from the pool.
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
   * Checks connection liveness using the native mysql2 COM_PING.
   */
  private pingConnection(connection: PoolConnection): Promise<boolean> {
    return new Promise((resolve) => {
      connection.ping((err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Acquires a connection from the pool for transaction processing.
   * When validateOnBorrow is enabled, pings the connection to confirm liveness
   * and replaces stale connections by discarding them and acquiring a new one.
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

        qb.query(sql, values, (error, results, fields) => {
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
      throw new OrmError(
        OrmErrorCode.INVALID_CONFIG,
        `Invalid isolation level: ${level}`,
      );
    }

    return new Promise((resolve, reject) => {
      if (!connection) {
        return reject(new ConnectionNotFound());
      }

      /**
       * The isolation level set on a connection applies only to transactions that run on that connection.
       */
      connection.query(safeSql, (error) => {
        if (error) {
          return reject(error);
        }

        resolve();
      });
    });
  }

  // MySQL default isolation level — skip SET TRANSACTION when it matches (#212)
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

      // #212: skip SET TRANSACTION when it matches the default isolation level
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
