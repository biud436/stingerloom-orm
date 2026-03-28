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
      // 이미 해제된 커넥션인 경우 무시
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

    await this.connector.rollback(this.connection);
    this.connection = undefined;
  }

  async commit() {
    if (!this.connection) {
      throw new MySqlConnectionError();
    }

    await this.connector.commit(this.connection);
    this.connection = undefined;
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
