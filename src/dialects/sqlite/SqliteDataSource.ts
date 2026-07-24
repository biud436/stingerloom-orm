/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "../../utils/sqlTag";
import { IConnector } from "../../core/IConnector";
import { IDataSource } from "../IDataSource";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { SqliteConnectionError } from "./SqliteConnectionError";
import { validateSavepointName } from "../../utils/validateSavepointName";

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
    // SQLite uses a single connection, so a separate release is not needed.
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

    validateSavepointName(name);
    const escaped = `"${name.replace(/"/g, '""')}"`;
    await this.query(`SAVEPOINT ${escaped}`);
  }

  async rollbackTo(name: string) {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    validateSavepointName(name);
    const escaped = `"${name.replace(/"/g, '""')}"`;
    await this.query(`ROLLBACK TO SAVEPOINT ${escaped}`);
  }
}
