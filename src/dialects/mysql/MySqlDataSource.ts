/* eslint-disable @typescript-eslint/no-explicit-any */
import { Connection } from "./Connection";
import { IConnector } from "../../core/IConnector";
import { IDataSource } from "../IDataSource";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { MySqlConnectionError } from "./MySqlConnectionError";
import { validateSavepointName } from "../../utils/validateSavepointName";

export class MySqlDataSource implements IDataSource {
  private connection?: Connection;

  constructor(private readonly connector: IConnector) {}

  async createConnection() {
    this.connection = await this.connector.getConnection();

    if (!this.connection) {
      throw new MySqlConnectionError();
    }
  }

  async close() {
    if (!this.connection) {
      return;
    }

    const conn = this.connection;
    this.connection = undefined;
    try {
      conn.release();
    } catch {
      // Ignore if the connection was already released
    }
  }

  async startTransaction(level?: TRANSACTION_ISOLATION_LEVEL) {
    if (!this.connection) {
      throw new MySqlConnectionError();
    }

    await this.connector.startTransaction(this.connection, level);
  }

  async rollback() {
    if (!this.connection) {
      throw new MySqlConnectionError();
    }

    // Clear the ref in `finally`: the connector may already have
    // released/destroyed the connection while handling a rollback error, so a
    // later close() must not release it a second time (double-release can hand
    // the same physical connection to two callers).
    try {
      await this.connector.rollback(this.connection);
    } finally {
      this.connection = undefined;
    }
  }

  async commit() {
    if (!this.connection) {
      throw new MySqlConnectionError();
    }

    // See rollback(): the connector may release the connection while recovering
    // from a commit error, so always drop our ref to avoid a double-release.
    try {
      await this.connector.commit(this.connection);
    } finally {
      this.connection = undefined;
    }
  }

  async query(sql: string) {
    if (!this.connection) {
      throw new MySqlConnectionError();
    }

    return await this.connector.query(sql, this.connection);
  }

  async savepoint(name: string) {
    if (!this.connection) {
      throw new MySqlConnectionError();
    }

    validateSavepointName(name);
    const escaped = `\`${name.replace(/`/g, "``")}\``;
    await this.query(`SAVEPOINT ${escaped}`);
  }

  async rollbackTo(name: string) {
    if (!this.connection) {
      throw new MySqlConnectionError();
    }

    validateSavepointName(name);
    const escaped = `\`${name.replace(/`/g, "``")}\``;
    await this.query(`ROLLBACK TO ${escaped}`);
  }
}
