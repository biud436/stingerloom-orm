/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "sql-template-tag";
import { IConnector } from "../../core/IConnector";
import { IDataSource } from "../IDataSource";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { PostgresConnectionError } from "./PostgresConnectionError";
import { validateSavepointName } from "../../utils/validateSavepointName";

export class PostgresDataSource implements IDataSource {
  private connection?: any;

  constructor(private readonly connector: IConnector) {}

  async createConnection() {
    this.connection = await this.connector.getConnection();

    if (!this.connection) {
      throw new PostgresConnectionError();
    }
  }

  async close() {
    if (!this.connection) {
      return;
    }

    try {
      this.connection.release();
    } catch {
      // Ignore if the connection was already released
    }
    this.connection = undefined;
  }

  async startTransaction(level?: TRANSACTION_ISOLATION_LEVEL) {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    await this.connector.startTransaction(this.connection, level);
  }

  async rollback() {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    try {
      await this.connector.rollback(this.connection);
    } finally {
      // PostgresConnector.rollback() always releases the client (destructively
      // on failure), so clear the reference even when the connector throws —
      // otherwise a later close() would attempt a double release.
      this.connection = undefined;
    }
  }

  async commit() {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    try {
      await this.connector.commit(this.connection);
    } finally {
      // PostgresConnector.commit() always releases the client (destructively
      // on failure), so clear the reference even when the connector throws.
      this.connection = undefined;
    }
  }

  async query(sql: string | Sql) {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    return await this.connector.query(sql as any, this.connection);
  }

  async savepoint(name: string) {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    validateSavepointName(name);
    const escaped = `"${name.replace(/"/g, '""')}"`;
    await this.query(`SAVEPOINT ${escaped}`);
  }

  async rollbackTo(name: string) {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    validateSavepointName(name);
    const escaped = `"${name.replace(/"/g, '""')}"`;
    await this.query(`ROLLBACK TO SAVEPOINT ${escaped}`);
  }
}
