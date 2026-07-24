/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from "better-sqlite3";
import { Sql } from "../../utils/sqlTag";
import { Logger } from "../../utils/Logger";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { ConnectionNotFound } from "./ConnectionNotFound";
import { DatabaseClientOptions } from "../../core/DatabaseClientOptions";
import { IConnector } from "../../core/IConnector";
import { IConnection } from "../IConnection";
import { SqliteConnection } from "./SqliteConnection";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { DbVersion } from "../DbVersion";
import { parseInlineFlags } from "../../core/expressions/RegexPattern";

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
  private _dbVersion: DbVersion = DbVersion.UNKNOWN;

  /**
   * Per-database prepared-statement LRU cache. The ORM emits identical
   * parameterized SQL strings over and over (point reads, batch writes), and
   * `db.prepare()` re-parses the SQL each call — a measurable share of
   * per-query CPU. SQLite's prepare_v2 machinery re-compiles a cached
   * statement automatically when the schema changes underneath it, so DDL
   * does not invalidate the cache; a statement whose table was dropped fails
   * on execution with the same error a fresh `prepare()` would raise.
   */
  private readonly stmtCaches = new WeakMap<
    Database.Database,
    Map<string, Database.Statement>
  >();
  private static readonly STMT_CACHE_MAX = 128;

  async connect(options: DatabaseClientOptions): Promise<void> {
    try {
      let DatabaseConstructor: typeof Database;
      try {
        // import() works in both builds: transpiled to require() in CJS,
        // kept as a real dynamic import in ESM (where require() does not exist).
        const sqliteModule: any = await import("better-sqlite3");
        DatabaseConstructor = sqliteModule.default ?? sqliteModule;
      } catch {
        throw new OrmError(
          OrmErrorCode.MISSING_DEPENDENCY,
          "The better-sqlite3 package is required.",
          "Run: npm install better-sqlite3",
        );
      }

      const { database, logging } = options;

      this.db = new DatabaseConstructor(database);
      this.isDebug = !!logging;

      // Enable WAL mode for better performance
      this.db.pragma("journal_mode = WAL");
      // Enable foreign key constraints
      this.db.pragma("foreign_keys = ON");
      // Register the `regexp` UDF so `col REGEXP pattern` (emitted by
      // `ColumnExpression.matches()`) works — better-sqlite3 reserves the
      // operator but ships no engine. SQLite invokes `regexp(pattern, value)`.
      this.registerRegexpFunction();

      // Detect SQLite version
      try {
        if (options.versionOverride) {
          this._dbVersion = DbVersion.parse(options.versionOverride);
        } else {
          const rows: any[] = await this.query("SELECT sqlite_version() as v");
          this._dbVersion = DbVersion.parse(rows[0]?.v ?? "unknown");
        }
      } catch {
        this._dbVersion = DbVersion.UNKNOWN;
      }
    } catch (e: unknown) {
      if (e instanceof OrmError) throw e;
      throw new OrmError(
        OrmErrorCode.CONNECTION_FAILED,
        `Failed to connect to SQLite. ${e}`,
        "Check that the database path is valid and writable",
      );
    }
  }

  /**
   * Register the `regexp(pattern, value)` scalar UDF backing the `REGEXP`
   * operator. The pattern may carry a leading inline-flag group (`"(?i)"`),
   * which {@link parseInlineFlags} maps to JS `RegExp` flags. Compiled
   * patterns are memoized per connection so a `WHERE col REGEXP ?` scan does
   * not recompile the `RegExp` for every row.
   */
  private registerRegexpFunction(): void {
    if (!this.db) return;
    const cache = new Map<string, RegExp>();
    this.db.function(
      "regexp",
      { deterministic: true },
      (pattern: unknown, value: unknown): number => {
        if (value === null || value === undefined) return 0;
        const key = String(pattern);
        let re = cache.get(key);
        if (!re) {
          const { source, jsFlags } = parseInlineFlags(key);
          re = new RegExp(source, jsFlags);
          cache.set(key, re);
        }
        return re.test(String(value)) ? 1 : 0;
      },
    );
  }

  override getVersion(): DbVersion {
    return this._dbVersion;
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
        // Mirror PostgresConnector's top-level `rowCount` so EntityManager's
        // affected-rows extraction (`... : queryResult.rowCount ?? 0`) works on
        // SQLite. better-sqlite3 reports write counts via `run().changes`; reads
        // return a row array. `results` keeps the raw shape (changes /
        // lastInsertRowid) for callers that need the inserted row id.
        return {
          results: raw,
          fields: null,
          rowCount: Array.isArray(raw) ? raw.length : (raw?.changes ?? 0),
        } as T;
      }
      return raw as T;
    } else {
      const { sql, values } = rawSql;

      if (this.isDebug) {
        this.logger.info(`Query: ${sql}, # ${JSON.stringify(values)}`);
      }

      const raw = this.executeRaw(db, sql, values);
      if (connection) {
        // Mirror PostgresConnector's top-level `rowCount` so EntityManager's
        // affected-rows extraction (`... : queryResult.rowCount ?? 0`) works on
        // SQLite. better-sqlite3 reports write counts via `run().changes`; reads
        // return a row array. `results` keeps the raw shape (changes /
        // lastInsertRowid) for callers that need the inserted row id.
        return {
          results: raw,
          fields: null,
          rowCount: Array.isArray(raw) ? raw.length : (raw?.changes ?? 0),
        } as T;
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

  /**
   * Returns a prepared statement for `sql`, reusing a cached one when
   * available. Entries are evicted least-recently-used beyond
   * {@link STMT_CACHE_MAX} so uniquely-named DDL (e.g. per-test tables)
   * cannot grow the cache without bound.
   */
  private prepareCached(
    db: Database.Database,
    sql: string,
  ): Database.Statement {
    let cache = this.stmtCaches.get(db);
    if (!cache) {
      cache = new Map();
      this.stmtCaches.set(db, cache);
    }

    let stmt = cache.get(sql);
    if (stmt) {
      // Refresh recency: Map iteration order doubles as the LRU order.
      cache.delete(sql);
      cache.set(sql, stmt);
      return stmt;
    }

    stmt = db.prepare(sql);
    cache.set(sql, stmt);
    if (cache.size > SqliteConnector.STMT_CACHE_MAX) {
      cache.delete(cache.keys().next().value!);
    }
    return stmt;
  }

  private executeRaw(db: Database.Database, sql: string, values?: any[]): any {
    const sanitized = this.sanitizeValues(values);
    const stmt = this.prepareCached(db, sql);

    // better-sqlite3 exposes `Statement.reader: boolean` — true iff the
    // statement returns rows. Branch on that flag instead of parsing SQL
    // text, which misclassifies leading comments and CTE-prefixed writes
    // (#287).
    if (stmt.reader) {
      return sanitized && sanitized.length > 0
        ? stmt.all(...sanitized)
        : stmt.all();
    }

    return sanitized && sanitized.length > 0
      ? stmt.run(...sanitized)
      : stmt.run();
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
