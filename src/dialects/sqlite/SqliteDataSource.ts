/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "sql-template-tag";
import { IConnector } from "../../core/IConnector";
import { IDataSource } from "../IDataSource";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { SqliteConnectionError } from "./SqliteConnectionError";

export class SqliteDataSource implements IDataSource {
  private connection?: any;

  constructor(private readonly connector: IConnector) {}

  async createConnection() {
    this.connection = await this.connector.getConnection();

    if (!this.connection) {
      throw new SqliteConnectionError();
    }
  }

  async close() {
    // SQLite는 단일 커넥션이므로 별도의 release가 필요 없습니다.
    this.connection = undefined;
  }

  async startTransaction(level?: TRANSACTION_ISOLATION_LEVEL) {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    await this.connector.startTransaction(this.connection, level);
  }

  async rollback() {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    await this.connector.rollback(this.connection);
  }

  async commit() {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    await this.connector.commit(this.connection);
  }

  async query(sql: string | Sql) {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    return await this.connector.query(sql as any, this.connection);
  }

  async savepoint(name: string) {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    await this.query(`SAVEPOINT ${name}`);
  }

  async rollbackTo(name: string) {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    await this.query(`ROLLBACK TO SAVEPOINT ${name}`);
  }
}
