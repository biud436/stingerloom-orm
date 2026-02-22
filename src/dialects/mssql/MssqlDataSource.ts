/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "sql-template-tag";
import { IConnector } from "../../core/IConnector";
import { IDataSource } from "../IDataSource";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { MssqlConnectionError } from "./MssqlConnectionError";

export class MssqlDataSource implements IDataSource {
  private connection?: any;

  constructor(private readonly connector: IConnector) {}

  async createConnection() {
    this.connection = await this.connector.getConnection();

    if (!this.connection) {
      throw new MssqlConnectionError();
    }
  }

  async close() {
    // ConnectionPool은 DatabaseClient에서 관리하므로
    // DataSource에서는 참조만 해제합니다.
    this.connection = undefined;
  }

  async startTransaction(level?: TRANSACTION_ISOLATION_LEVEL) {
    if (!this.connection) {
      throw new MssqlConnectionError();
    }

    await this.connector.startTransaction(this.connection, level);
  }

  async rollback() {
    if (!this.connection) {
      throw new MssqlConnectionError();
    }

    await this.connector.rollback(this.connection);
  }

  async commit() {
    if (!this.connection) {
      throw new MssqlConnectionError();
    }

    await this.connector.commit(this.connection);
  }

  async query(sql: string | Sql) {
    if (!this.connection) {
      throw new MssqlConnectionError();
    }

    return await this.connector.query(sql as any, this.connection);
  }

  async savepoint(name: string) {
    if (!this.connection) {
      throw new MssqlConnectionError();
    }

    await this.query(`SAVE TRANSACTION ${name}`);
  }

  async rollbackTo(name: string) {
    if (!this.connection) {
      throw new MssqlConnectionError();
    }

    await this.query(`ROLLBACK TRANSACTION ${name}`);
  }
}
