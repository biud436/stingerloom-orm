/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import { Sql } from "sql-template-tag";
import { Logger } from "../../utils/Logger";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { ConnectionNotFound } from "./ConnectionNotFound";
import { DatabaseClientOptions } from "../../core/DatabaseClientOptions";
import { IConnector } from "../../core/IConnector";

/**
 * SQLite 커넥터 구현체입니다.
 * better-sqlite3 패키지를 사용하여 동기식 SQLite 접근을 비동기 인터페이스로 래핑합니다.
 *
 * SQLite는 파일 기반 데이터베이스이므로 host/port/username/password 대신
 * database 필드에 파일 경로를 지정합니다. ":memory:"를 사용하면 인메모리 DB를 생성합니다.
 */
export class SqliteConnector extends IConnector {
  private db?: Database.Database;
  private isDebug = false;
  private readonly logger = new Logger("SqliteConnector");

  async connect(options: DatabaseClientOptions): Promise<void> {
    try {
      const { database, logging } = options;

      this.db = new Database(database);
      this.isDebug = !!logging;

      // WAL 모드 활성화 (성능 향상)
      this.db.pragma("journal_mode = WAL");
      // 외래키 제약 활성화
      this.db.pragma("foreign_keys = ON");
    } catch (e: unknown) {
      throw new Error(`SQLite 연결에 실패했습니다. ${e}`);
    }
  }

  /**
   * SQLite는 커넥션 풀이 없으므로 DB 인스턴스 자체를 반환합니다.
   */
  async getConnection(): Promise<Database.Database> {
    if (!this.db) {
      throw new ConnectionNotFound();
    }

    return this.db;
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

      return this.executeRaw(db, rawSql) as T;
    } else {
      const { sql, values } = rawSql;

      if (this.isDebug) {
        this.logger.info(`Query: ${sql}, # ${JSON.stringify(values)}`);
      }

      return this.executeRaw(db, sql, values) as T;
    }
  }

  private executeRaw(db: Database.Database, sql: string, values?: any[]): any {
    const trimmed = sql.trimStart().toUpperCase();

    // SELECT / PRAGMA / EXPLAIN / WITH (CTE) 등 결과를 반환하는 구문
    if (
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("EXPLAIN") ||
      trimmed.startsWith("WITH")
    ) {
      const stmt = db.prepare(sql);
      return values && values.length > 0 ? stmt.all(...values) : stmt.all();
    }

    // INSERT / UPDATE / DELETE / CREATE / ALTER / DROP 등
    const stmt = db.prepare(sql);
    const result =
      values && values.length > 0 ? stmt.run(...values) : stmt.run();

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
    // SQLite는 트랜잭션 격리 수준 설정을 지원하지 않습니다.
    // SQLite는 기본적으로 SERIALIZABLE 수준의 격리를 제공합니다.
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
