/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from "better-sqlite3";
import { Sql } from "sql-template-tag";
import { Logger } from "../../utils/Logger";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { ConnectionNotFound } from "./ConnectionNotFound";
import { DatabaseClientOptions } from "../../core/DatabaseClientOptions";
import { IConnector } from "../../core/IConnector";
import { IConnection } from "../IConnection";
import { SqliteConnection } from "./SqliteConnection";

/**
 * SQLite connector implementation.
 * Wraps synchronous SQLite access via the better-sqlite3 package behind an async interface.
 *
 * Since SQLite is a file-based database, specify the file path in the database field
 * instead of host/port/username/password. Use ":memory:" to create an in-memory database.
 */
export class SqliteConnector extends IConnector {
  private db?: Database.Database;
  private isDebug = false;
  private readonly logger = new Logger("SqliteConnector");

  async connect(options: DatabaseClientOptions): Promise<void> {
    try {
      let DatabaseConstructor: typeof Database;
      try {
        DatabaseConstructor = require("better-sqlite3");
      } catch {
        throw new Error(
          "better-sqlite3 패키지가 필요합니다. npm install better-sqlite3",
        );
      }

      const { database, logging } = options;

      this.db = new DatabaseConstructor(database);
      this.isDebug = !!logging;

      // Enable WAL mode for better performance
      this.db.pragma("journal_mode = WAL");
      // Enable foreign key constraints
      this.db.pragma("foreign_keys = ON");
    } catch (e: unknown) {
      throw new Error(`Failed to connect to SQLite. ${e}`);
    }
  }

  /**
   * Since SQLite has no connection pool, returns the database instance itself.
   */
  async getConnection(): Promise<Database.Database> {
    if (!this.db) {
      throw new ConnectionNotFound();
    }

    return this.db;
  }

  async acquireConnection(): Promise<IConnection<Database.Database>> {
    const raw = await this.getConnection();
    return new SqliteConnection(raw);
  }

  async runTestSql(): Promise<void> {
    if (!this.db) {
      return;
    }

    await this.query("SELECT 1 + 1");
  }

  async query(sql: string, connection?: any): Promise<any>;
  async query<T = any>(sql: Sql, connection?: any): Promise<T>;
  async query<T = any>(rawSql: Sql | string, connection?: any): Promise<T> {
    const db = connection ?? this.db;
    if (!db) {
      throw new ConnectionNotFound();
    }

    if (typeof rawSql === "string") {
      if (this.isDebug) {
        this.logger.info(`Query: ${rawSql}`);
      }

      const raw = this.executeRaw(db, rawSql);
      if (connection) {
        return { results: raw, fields: null } as T;
      }
      return raw as T;
    } else {
      const { sql, values } = rawSql;

      if (this.isDebug) {
        this.logger.info(`Query: ${sql}, # ${JSON.stringify(values)}`);
      }

      const raw = this.executeRaw(db, sql, values);
      if (connection) {
        return { results: raw, fields: null } as T;
      }
      return raw as T;
    }
  }

  /**
   * Sanitize bind values for better-sqlite3.
   * better-sqlite3 only accepts: number | string | bigint | Buffer | null.
   * - boolean `true`/`false` → `1`/`0`
   * - Date objects → ISO 8601 string
   * - undefined → null
   */
  private sanitizeValues(values?: any[]): any[] | undefined {
    if (!values) return values;
    return values.map((v) => {
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v instanceof Date) return v.toISOString();
      if (v === undefined) return null;
      return v;
    });
  }

  private executeRaw(db: Database.Database, sql: string, values?: any[]): any {
    const sanitized = this.sanitizeValues(values);
    const trimmed = sql.trimStart().toUpperCase();

    // Statements that return rows: SELECT / PRAGMA / EXPLAIN / WITH (CTE)
    if (
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("EXPLAIN") ||
      trimmed.startsWith("WITH")
    ) {
      const stmt = db.prepare(sql);
      return sanitized && sanitized.length > 0
        ? stmt.all(...sanitized)
        : stmt.all();
    }

    // Non-query statements: INSERT / UPDATE / DELETE / CREATE / ALTER / DROP
    const stmt = db.prepare(sql);
    const result =
      sanitized && sanitized.length > 0
        ? stmt.run(...sanitized)
        : stmt.run();

    return result;
  }

  async close(): Promise<void> {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = undefined;
  }

  async setTransactionIsolationLevel(
    _connection: any,
    _level: TRANSACTION_ISOLATION_LEVEL,
  ): Promise<void> {
    // SQLite does not support setting transaction isolation levels.
    // SQLite natively provides SERIALIZABLE isolation.
  }

  async startTransaction(
    connection: any,
    _level: TRANSACTION_ISOLATION_LEVEL = "READ COMMITTED",
  ): Promise<void> {
    const db = connection as Database.Database;
    if (!db) {
      throw new ConnectionNotFound();
    }

    db.exec("BEGIN");
  }

  async rollback(connection: any): Promise<void> {
    const db = connection as Database.Database;
    if (!db) {
      throw new ConnectionNotFound();
    }

    db.exec("ROLLBACK");
  }

  async commit(connection: any): Promise<void> {
    const db = connection as Database.Database;
    if (!db) {
      throw new ConnectionNotFound();
    }

    try {
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
