/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "../../utils/sqlTag";
import { IConnector } from "../../core/IConnector";
import { IDataSource } from "../IDataSource";
import { TRANSACTION_ISOLATION_LEVEL } from "../IsolationLevel";
import { SqliteConnectionError } from "./SqliteConnectionError";
import { validateSavepointName } from "../../utils/validateSavepointName";
import type { DriverQueryOptions } from "../../types/DriverQueryOptions";
import { sqliteQueryWithOptions } from "./sqliteQueryWithOptions";
import { SqliteTransactionGate } from "./SqliteTransactionGate";
import { currentTransactionFlow, TransactionFlow } from "../TransactionFlow";

/**
 * A session on the SQLite connection. Every session shares the connector's
 * single handle, so a session the ORM opens for a transaction takes the
 * connection's turn (see {@link SqliteTransactionGate}) from BEGIN until
 * COMMIT or ROLLBACK.
 */
export class SqliteDataSource implements IDataSource {
  private connection?: any;
  /** The transaction flow this session was opened in, if any. */
  private flow?: TransactionFlow;
  /** The flow this session's transaction holds the connection for. */
  private turn?: TransactionFlow;
  /** Whether this session's BEGIN ran and its COMMIT or ROLLBACK has not. */
  private inTransaction = false;

  constructor(private readonly connector: IConnector) {}

  async createConnection() {
    this.connection = await this.connector.getConnection();

    if (!this.connection) {
      throw new SqliteConnectionError();
    }
    this.flow = currentTransactionFlow();
  }

  async close() {
    // SQLite uses a single connection, so a separate release is not needed.
    // A transaction left open would keep the connection from everyone else.
    try {
      if (this.inTransaction) await this.rollback();
    } finally {
      this.endTurn();
      this.connection = undefined;
    }
  }

  async startTransaction(level?: TRANSACTION_ISOLATION_LEVEL) {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    if (this.flow) {
      await this.gate().begin(this.flow);
      this.turn = this.flow;
    }
    try {
      await this.connector.startTransaction(this.connection, level);
      this.inTransaction = true;
    } catch (error) {
      this.endTurn();
      throw error;
    }
  }

  async rollback() {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    // ROLLBACK ends whatever transaction is open on the shared handle. A
    // session the ORM opened that never began has none of its own, and the
    // open one may be another session's.
    if (this.flow && !this.inTransaction) return;
    try {
      await this.connector.rollback(this.connection);
    } finally {
      this.inTransaction = false;
      this.endTurn();
    }
  }

  async commit() {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    try {
      await this.connector.commit(this.connection);
    } finally {
      // A failed COMMIT is rolled back by the connector.
      this.inTransaction = false;
      this.endTurn();
    }
  }

  private gate(): SqliteTransactionGate {
    return SqliteTransactionGate.of(this.connection);
  }

  private endTurn(): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    this.gate().end(turn);
  }

  async query(sql: string | Sql) {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    return await this.connector.query(sql as any, this.connection);
  }

  async queryWithOptions(sql: Sql, options: DriverQueryOptions) {
    if (!this.connection) {
      throw new SqliteConnectionError();
    }

    return this.gate().run(() => sqliteQueryWithOptions(this.connection, sql, options));
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
