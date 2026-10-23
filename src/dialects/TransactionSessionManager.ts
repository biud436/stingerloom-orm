/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "../utils/sqlTag";
import { DatabaseClient } from "../DatabaseClient";
import { IConnector } from "../core/IConnector";
import { IDataSource } from "./IDataSource";
import { Logger } from "../utils";
import { DatabaseConnectionFailedError } from "../errors/DatabaseConnectionFailedError";
import { DatabaseNotConnectedError } from "../errors/DatabaseNotConnectedError";
import { IQueryEngine } from "./IQueryEngine";
import { TRANSACTION_ISOLATION_LEVEL } from "./IsolationLevel";
import { Exception } from "../errors";
import { ReplicationNodeConfig } from "./ReplicationRouter";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { validateSavepointName } from "../utils/validateSavepointName";
import type { DriverQueryOptions } from "../types/DriverQueryOptions";

/**
 * The `TransactionHolder` class extends the `IQueryEngine` and is responsible for managing
 * database transactions and connections. It provides methods to connect to the database,
 * execute queries, and handle transactions.
 */
export class TransactionSessionManager extends IQueryEngine {
  private connection?: IConnector;
  private dataSource?: IDataSource;
  private readonly logger: Logger = new Logger(TransactionSessionManager.name);
  private transactionEndCallbacks: Array<
    (committed: boolean) => void | Promise<void>
  > = [];
  private transactionActive = false;
  /** See {@link onRollback}. */
  private rollbackUndos: Array<() => void> = [];
  /** Open savepoints, oldest first, with the undo count when each was taken. */
  private savepointMarks: Array<{ name: string; undoCount: number }> = [];

  /**
   * Constructs a new instance of the `TransactionHolder` class.
   */
  constructor() {
    super();
  }

  private async createDataSource(
    dbType: string | undefined,
    connection: IConnector,
  ): Promise<IDataSource> {
    if (dbType === "postgres") {
      const { PostgresDataSource } = await import(
        "./postgres/PostgresDataSource"
      );
      return new PostgresDataSource(connection);
    } else if (dbType === "sqlite") {
      const { SqliteDataSource } = await import("./sqlite/SqliteDataSource");
      return new SqliteDataSource(connection);
    } else if (dbType === "mysql" || dbType === "mariadb") {
      const { MySqlDataSource } = await import("./mysql/MySqlDataSource");
      return new MySqlDataSource(connection);
    }
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      `Unsupported database type: ${dbType}`,
      "Supported types: mysql, mariadb, postgres, sqlite",
    );
  }

  /**
   * Establishes a connection to the database and initializes the data source.
   *
   * @throws {DatabaseConnectionFailedError} If the connection to the database fails.
   */
  public async connect(connectionName?: string) {
    try {
      this.connection = connectionName
        ? await DatabaseClient.getInstance().getConnection(connectionName)
        : await DatabaseClient.getInstance().getConnection();

      const dbType = connectionName
        ? DatabaseClient.getInstance().getType?.(connectionName) ?? DatabaseClient.getInstance().type
        : DatabaseClient.getInstance().type;
      this.dataSource = await this.createDataSource(dbType, this.connection);

      await this.dataSource.createConnection();
    } catch (error: unknown) {
      throw new DatabaseConnectionFailedError(error);
    }
  }

  /**
   * Creates a dedicated connection to the specified replication node.
   * Used when connecting directly to a slave node for Read Replica support.
   *
   * @param nodeConfig Configuration of the node to connect to
   * @throws {DatabaseConnectionFailedError} When the connection fails
   */
  public async connectToNode(nodeConfig: ReplicationNodeConfig): Promise<void> {
    let connector: IConnector | undefined;
    try {
      const dbType = DatabaseClient.getInstance().type;
      const options = DatabaseClient.getInstance().getOptions();

      if (dbType === "postgres") {
        const { PostgresConnector } = await import(
          "./postgres/PostgresConnector"
        );
        connector = new PostgresConnector();
      } else {
        // mysql, mariadb
        const { MySqlConnector } = await import("./mysql/MySqlConnector");
        connector = new MySqlConnector();
      }

      // Connect using the node config (overrides host/port/username/password/database from the original options)
      await connector.connect({
        ...options,
        host: nodeConfig.host,
        port: nodeConfig.port,
        username: nodeConfig.username,
        password: nodeConfig.password,
        database: nodeConfig.database,
      });

      this.connection = connector;
      this.dataSource = await this.createDataSource(dbType, this.connection);

      await this.dataSource.createConnection();
    } catch (error: unknown) {
      if (connector && connector !== this.connection) {
        try { await connector.close(); } catch { /* ignore */ }
      }
      throw new DatabaseConnectionFailedError(error);
    }
  }

  /**
   * Executes a SQL query on the connected database.
   *
   * @param sql - The SQL query string or `Sql` object to be executed.
   * @returns The result of the query.
   * @throws {DatabaseNotConnectedError} If there is no active database connection.
   */
  public async query(sql: string): Promise<any>;
  public async query<T = any>(sql: Sql): Promise<T>;
  public async query<T = any>(sql: string | Sql): Promise<T> {
    if (!this.connection) {
      throw new DatabaseNotConnectedError();
    }
    const queryResult = await this.dataSource?.query(sql as any);

    return queryResult;
  }

  /**
   * Executes a query on this session's connection with driver-level result
   * options (binary values, array rows) — the session-bound counterpart of
   * `ISqlDriver.queryWithOptions()`, which reads from the pool. Inside a
   * transaction it reads the transaction's own writes and snapshot.
   *
   * @throws {DatabaseNotConnectedError} If there is no active database connection.
   */
  public async queryWithOptions(sql: Sql, options: DriverQueryOptions): Promise<any[]> {
    if (!this.connection || !this.dataSource) {
      throw new DatabaseNotConnectedError();
    }
    if (!this.dataSource.queryWithOptions) {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_OPERATION,
        "This data source cannot run queries with driver-level options",
        "Implement IDataSource.queryWithOptions()",
      );
    }
    return this.dataSource.queryWithOptions(sql, options);
  }

  /**
   * Starts a new transaction with the specified isolation level.
   *
   * @param level - The isolation level for the transaction. A given level is
   * always applied. Omitted, PostgreSQL runs at the server's default
   * (`default_transaction_isolation`, READ COMMITTED unless configured) and
   * MySQL/MariaDB at READ COMMITTED.
   * @returns A promise that resolves when the transaction is started.
   * @throws {DatabaseNotConnectedError} If there is no active database connection.
   */
  public async startTransaction(level?: TRANSACTION_ISOLATION_LEVEL) {
    if (!this.connection) {
      throw new DatabaseNotConnectedError();
    }

    const result = await this.dataSource?.startTransaction(level);
    this.transactionActive = true;
    return result;
  }

  /**
   * Whether a transaction begun by `startTransaction()` is still open on
   * this session — COMMIT or ROLLBACK not yet issued. Register an
   * `onTransactionEnd()` callback only while this is true: once the
   * transaction is over, the callback would wait for one that may never come.
   */
  public get isTransactionActive(): boolean {
    return this.transactionActive;
  }

  /**
   * Register a one-shot callback fired when this session's transaction ends:
   * `true` after a successful COMMIT, `false` after ROLLBACK (also when the
   * ROLLBACK statement itself fails).
   * Savepoint partial rollbacks (`rollbackTo`) do not fire it. Callbacks run
   * in reverse registration order (later registrants undo their state first,
   * so earlier snapshots win — LIFO, like nested restores) and are cleared
   * after firing. An async callback is awaited before `commit()` /
   * `rollback()` resolves. A callback error is logged, never propagated: the
   * transaction outcome is already decided when callbacks run.
   *
   * Used by participants that join an ambient transaction (e.g. WriteBuffer
   * flush, query cache invalidation) and must reconcile in-memory state with
   * the transaction outcome.
   */
  public onTransactionEnd(
    callback: (committed: boolean) => void | Promise<void>,
  ): void {
    this.transactionEndCallbacks.push(callback);
  }

  /**
   * Register an action that puts back in-memory state a write in this
   * transaction changed. It runs if that write is rolled back: on ROLLBACK
   * (also when the statement itself fails), or on `rollbackTo()` a savepoint
   * taken before it was registered. COMMIT discards it.
   *
   * Undo actions run newest first, before the `onTransactionEnd()`
   * callbacks. An undo action that throws is logged and skipped. Outside an
   * open transaction there is nothing to roll back and the action is
   * dropped.
   */
  public onRollback(undo: () => void): void {
    if (!this.transactionActive) return;
    this.rollbackUndos.push(undo);
  }

  private runRollbackUndos(undos: Array<() => void>): void {
    for (let i = undos.length - 1; i >= 0; i--) {
      try {
        undos[i]();
      } catch (error) {
        this.logger.warn(`rollback undo action failed: ${error}`);
      }
    }
  }

  private async fireTransactionEnd(committed: boolean): Promise<void> {
    const callbacks = this.transactionEndCallbacks;
    this.transactionEndCallbacks = [];
    for (let i = callbacks.length - 1; i >= 0; i--) {
      try {
        await callbacks[i](committed);
      } catch (error) {
        this.logger.warn(
          `transaction-end callback failed (outcome already ${committed ? "committed" : "rolled back"}): ${error}`,
        );
      }
    }
  }

  /**
   * Rolls back the current transaction. The transaction-end callbacks fire
   * even when the ROLLBACK statement itself fails — the transaction is over
   * either way, and nothing it wrote was committed.
   *
   * @returns A promise that resolves when the transaction is rolled back.
   */
  public async rollback() {
    try {
      return await this.dataSource?.rollback();
    } finally {
      this.transactionActive = false;
      const undos = this.rollbackUndos;
      this.rollbackUndos = [];
      this.savepointMarks = [];
      this.runRollbackUndos(undos);
      if (this.transactionEndCallbacks.length > 0) {
        await this.fireTransactionEnd(false);
      }
    }
  }

  /**
   * Commits the current transaction.
   *
   * @returns A promise that resolves when the transaction is committed.
   */
  public async commit() {
    const result = await this.dataSource?.commit();
    this.transactionActive = false;
    this.rollbackUndos = [];
    this.savepointMarks = [];
    if (this.transactionEndCallbacks.length > 0) {
      await this.fireTransactionEnd(true);
    }
    return result;
  }

  /**
   * Creates a savepoint with the given name in the current transaction.
   *
   * @param name - The name of the savepoint.
   * @returns A promise that resolves when the savepoint is created.
   */
  public async savepoint(name: string) {
    validateSavepointName(name);
    const result = await this.dataSource?.savepoint(name);
    this.savepointMarks.push({ name, undoCount: this.rollbackUndos.length });
    return result;
  }

  /**
   * Rolls back the current transaction to the specified savepoint, and runs
   * the {@link onRollback} actions registered since it was taken.
   *
   * @param name - The name of the savepoint to roll back to.
   * @returns A promise that resolves when the transaction is rolled back to the savepoint.
   */
  public async rollbackTo(name: string) {
    validateSavepointName(name);
    const result = await this.dataSource?.rollbackTo(name);
    let index = this.savepointMarks.length - 1;
    while (index >= 0 && this.savepointMarks[index].name !== name) index--;
    if (index >= 0) {
      // The savepoint survives ROLLBACK TO; the ones taken after it do not.
      const { undoCount } = this.savepointMarks[index];
      this.savepointMarks.length = index + 1;
      this.runRollbackUndos(this.rollbackUndos.splice(undoCount));
    }
    return result;
  }

  /**
   * Closes the current database connection.
   *
   * @throws {DatabaseNotConnectedError} If there is no active database connection.
   */
  public async close() {
    if (!this.connection) {
      throw new DatabaseNotConnectedError();
    }

    await this.dataSource?.close();
  }
}
