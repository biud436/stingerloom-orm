/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "sql-template-tag";
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

/**
 * The `TransactionHolder` class extends the `IQueryEngine` and is responsible for managing
 * database transactions and connections. It provides methods to connect to the database,
 * execute queries, and handle transactions.
 */
export class TransactionSessionManager extends IQueryEngine {
  private connection?: IConnector;
  private dataSource?: IDataSource;
  private readonly logger: Logger = new Logger(TransactionSessionManager.name);

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
   * Starts a new transaction with the specified isolation level.
   *
   * @param level - The isolation level for the transaction. Defaults to "READ COMMITTED".
   * @returns A promise that resolves when the transaction is started.
   * @throws {DatabaseNotConnectedError} If there is no active database connection.
   */
  public async startTransaction(
    level: TRANSACTION_ISOLATION_LEVEL = "READ COMMITTED",
  ) {
    if (!this.connection) {
      throw new DatabaseNotConnectedError();
    }

    return this.dataSource?.startTransaction(level);
  }

  /**
   * Rolls back the current transaction.
   *
   * @returns A promise that resolves when the transaction is rolled back.
   */
  public async rollback() {
    return this.dataSource?.rollback();
  }

  /**
   * Commits the current transaction.
   *
   * @returns A promise that resolves when the transaction is committed.
   */
  public async commit() {
    return this.dataSource?.commit();
  }

  /**
   * Creates a savepoint with the given name in the current transaction.
   *
   * @param name - The name of the savepoint.
   * @returns A promise that resolves when the savepoint is created.
   */
  public async savepoint(name: string) {
    validateSavepointName(name);
    return this.dataSource?.savepoint(name);
  }

  /**
   * Rolls back the current transaction to the specified savepoint.
   *
   * @param name - The name of the savepoint to roll back to.
   * @returns A promise that resolves when the transaction is rolled back to the savepoint.
   */
  public async rollbackTo(name: string) {
    validateSavepointName(name);
    return this.dataSource?.rollbackTo(name);
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
