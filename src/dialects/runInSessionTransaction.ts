/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Sql } from "../utils/sqlTag";
import { IConnector } from "../core/IConnector";
import { DatabaseClientOptions } from "../core/DatabaseClientOptions";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { DbVersion } from "./DbVersion";
import { IConnection } from "./IConnection";
import { IDataSource } from "./IDataSource";
import { TRANSACTION_ISOLATION_LEVEL } from "./IsolationLevel";
import { runInTransactionFlow } from "./TransactionFlow";

/**
 * Runs `work` in one transaction on the connection `session` checks out of
 * `connector`. `work` gets a connector whose statements all run on that
 * connection, in the transaction, and come back as rows the way a pool
 * query returns them. COMMIT when `work` resolves, ROLLBACK when anything
 * before COMMIT throws; the connection is released either way.
 *
 * The transaction runs in a flow of its own, so a connection that serves
 * one transaction at a time (SQLite) runs its statements and holds other
 * work back until it ends.
 *
 * @internal Package-internal — not a public API.
 */
export function runInSessionTransaction<R>(
  connector: IConnector,
  session: IDataSource,
  work: (connector: IConnector) => Promise<R>,
): Promise<R> {
  return runInTransactionFlow(async () => {
    await session.createConnection();
    // Set before COMMIT: a failed COMMIT has already been rolled back by the
    // connector, which also released the connection.
    let ending = false;
    try {
      await session.startTransaction();
      const result = await work(new SessionConnector(connector, session));
      ending = true;
      await session.commit();
      return result;
    } catch (error) {
      if (!ending) {
        try {
          await session.rollback();
        } catch (rollbackError) {
          const original = error instanceof Error ? error : new Error(String(error));
          const combined = new OrmError(
            OrmErrorCode.TRANSACTION_ROLLBACK_FAILED,
            `Transaction failed and rollback also failed: ${original.message}`,
          );
          (combined as any).cause = original;
          (combined as any).rollbackError = rollbackError;
          throw combined;
        }
      }
      throw error;
    } finally {
      await session.close();
    }
  });
}

/**
 * The connector a driver works through inside {@link runInSessionTransaction}:
 * every statement runs on the session's connection. It opens no connection
 * and no transaction of its own.
 */
class SessionConnector extends IConnector {
  constructor(
    private readonly base: IConnector,
    private readonly session: IDataSource,
  ) {
    super();
  }

  async query(sql: string | Sql, connection?: any): Promise<any> {
    if (connection !== undefined) {
      return this.base.query(sql as any, connection);
    }
    // A session query returns the shape of a query on an explicit
    // connection, `{ results, ... }`; the pool returns the rows themselves.
    const result = await this.session.query(sql as any);
    return result?.results ?? result;
  }

  getVersion(): DbVersion {
    return this.base.getVersion();
  }

  getPoolSize(): number | undefined {
    return 1;
  }

  async getConnection(): Promise<any> {
    throw this.unsupported("check out another connection");
  }

  async acquireConnection(): Promise<IConnection> {
    throw this.unsupported("check out another connection");
  }

  async connect(_options: DatabaseClientOptions): Promise<void> {
    throw this.unsupported("connect");
  }

  async close(): Promise<void> {
    throw this.unsupported("close the connection");
  }

  runTestSql(): void {
    throw this.unsupported("run a test statement");
  }

  async setTransactionIsolationLevel(
    _connection: any,
    _level: TRANSACTION_ISOLATION_LEVEL,
  ): Promise<void> {
    throw this.unsupported("change the isolation level");
  }

  async startTransaction(_connection: any, _level?: TRANSACTION_ISOLATION_LEVEL): Promise<void> {
    throw this.unsupported("start another transaction");
  }

  async rollback(_connection: any): Promise<void> {
    throw this.unsupported("roll back");
  }

  async commit(_connection: any): Promise<void> {
    throw this.unsupported("commit");
  }

  private unsupported(what: string): OrmError {
    return new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `Cannot ${what} inside this transaction: its work runs on the one connection the transaction holds.`,
    );
  }
}
