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
      // 이미 해제된 커넥션인 경우 무시
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

    await this.connector.rollback(this.connection);
    // PostgresConnector.rollback() 내부에서 client.release()를 호출하므로
    // 커넥션 참조를 정리하여 이중 해제를 방지합니다.
    this.connection = undefined;
  }

  async commit() {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    await this.connector.commit(this.connection);
    // PostgresConnector.commit() 내부에서 client.release()를 호출하므로
    // 커넥션 참조를 정리하여 이중 해제를 방지합니다.
    this.connection = undefined;
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
    await this.query(`SAVEPOINT ${name}`);
  }

  async rollbackTo(name: string) {
    if (!this.connection) {
      throw new PostgresConnectionError();
    }

    validateSavepointName(name);
    await this.query(`ROLLBACK TO SAVEPOINT ${name}`);
  }
}
