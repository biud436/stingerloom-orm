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
import { DbVersion } from "../DbVersion";

export class PostgresConnector extends IConnector {
  pool?: Pool;
  private isDebug = false;
  private schema = "public";
  private validateOnBorrow = false;
  private readonly logger = new Logger("PostgresConnector");
  private _dbVersion: DbVersion = DbVersion.UNKNOWN;

  private static readonly ISOLATION_LEVEL_SQL: Record<string, string> = {
    "READ UNCOMMITTED": "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED",
    "READ COMMITTED": "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    "REPEATABLE READ": "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    "SERIALIZABLE": "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
  };

  /**
   * Validates a PostgreSQL identifier (only alphanumerics, underscores, and dollar signs are allowed).
   * Throws when the name contains invalid characters.
   */
  private static validateIdentifier(name: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_$-]*$/.test(name)) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        `Invalid identifier: "${name}". Only alphanumeric characters, underscores, hyphens, and dollar signs are allowed.`,
        "Use a valid PostgreSQL identifier (alphanumeric + underscore + hyphen)",
      );
    }
  }

  /**
   * Wraps the identifier in double quotes (PostgreSQL standard) and returns it.
   * Any embedded `"` character is escaped as `""`, following the PostgreSQL standard.
   * Also performs strict validation.
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

      // Apply in priority order: pool.max > connectionLimit > default (10)
      const maxConnections = poolOptions?.max ?? options.connectionLimit ?? 10;

      // Convert SSL/TLS options
      const ssl = "ssl" in options ? options.ssl : undefined;
      let sslConfig: any = undefined;
      if (ssl === true) {
        sslConfig = { rejectUnauthorized: true };
      } else if (ssl && typeof ssl === "object") {
        sslConfig = { ...ssl };
      }

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
        ...(sslConfig ? { ssl: sslConfig } : {}),
      });

      this.isDebug = !!logging;
      this.validateOnBorrow = poolOptions?.validateOnBorrow ?? false;
      this.pool = pool;

      // Set the default search_path.
      // This is then applied to every connection acquired from the pool.
      const safeSchema = this.escapeIdentifier(this.schema);
      this.pool.on("connect", (client) => {
        client.query(`SET search_path TO ${safeSchema}`);
      });

      // Detect database version
      try {
        if (options.versionOverride) {
          this._dbVersion = DbVersion.parse(options.versionOverride);
        } else {
          const rows: any[] = await this.query("SELECT version() as v");
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
        `PostgreSQL 연결에 실패했습니다. ${e}`,
        "Check that the PostgreSQL server is running and reachable",
      );
    }
  }

  override getVersion(): DbVersion {
    return this._dbVersion;
  }

  /**
   * Acquires a raw client from the pool.
   */
  private async acquireRawConnection(): Promise<PoolClient> {
    if (!this.pool) {
      throw new PoolNotFound();
    }

    return this.pool.connect();
  }

  /**
   * Checks connection liveness with SELECT 1.
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
   * Acquires a connection from the pool for transaction processing.
   * When validateOnBorrow is enabled, issues SELECT 1 to confirm liveness
   * and replaces stale connections by discarding them and acquiring a new one.
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

      // PostgreSQL uses $1, $2 style parameters.
      // sql-template-tag uses ?, so conversion is required.
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

  // PostgreSQL default isolation level — skip SET TRANSACTION when it matches (#212)
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

    // #212: skip SET TRANSACTION when it matches the default isolation level
    if (level !== PostgresConnector.DEFAULT_ISOLATION) {
      await this.setTransactionIsolationLevel(client, level);
    }

    // #213: multi-tenancy — skip SET LOCAL when the schema is "public"
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
