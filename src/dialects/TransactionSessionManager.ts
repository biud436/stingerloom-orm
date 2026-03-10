/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "sql-template-tag";
import { DatabaseClient } from "../DatabaseClient";
import { IConnector } from "../core/IConnector";
import { MySqlDataSource } from "./mysql/MySqlDataSource";
import { PostgresDataSource } from "./postgres/PostgresDataSource";
import { SqliteDataSource } from "./sqlite/SqliteDataSource";
import { IDataSource } from "./IDataSource";
import { Logger } from "../utils";
import { DatabaseConnectionFailedError } from "../errors/DatabaseConnectionFailedError";
import { DatabaseNotConnectedError } from "../errors/DatabaseNotConnectedError";
import { IQueryEngine } from "./IQueryEngine";
import { TRANSACTION_ISOLATION_LEVEL } from "./IsolationLevel";
import { Exception } from "../errors";
import { ReplicationNodeConfig } from "./ReplicationRouter";
import { MySqlConnector } from "./mysql/MySqlConnector";
import { PostgresConnector } from "./postgres/PostgresConnector";
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

  /**
   * Establishes a connection to the database and initializes the data source.
   *
   * @throws {DatabaseConnectionFailedError} If the connection to the database fails.
   */
  public async connect() {
    try {
      this.connection = await DatabaseClient.getInstance().getConnection();

      const dbType = DatabaseClient.getInstance().type;
      if (dbType === "postgres") {
        this.dataSource = new PostgresDataSource(this.connection);
      } else if (dbType === "sqlite") {
        this.dataSource = new SqliteDataSource(this.connection);
      } else if (dbType === "mysql") {
        this.dataSource = new MySqlDataSource(this.connection);
      } else {
        throw new Error(`Unsupported database type: ${dbType}`);
      }

      await this.dataSource.createConnection();
    } catch (error: unknown) {
      throw new DatabaseConnectionFailedError();
    }
  }

  /**
   * 지정된 replication 노드에 대한 별도 연결을 생성합니다.
   * Read Replica 지원을 위해 slave 노드에 직접 연결할 때 사용합니다.
   *
   * @param nodeConfig 연결할 노드의 설정
   * @throws {DatabaseConnectionFailedError} 연결 실패 시
   */
  public async connectToNode(nodeConfig: ReplicationNodeConfig): Promise<void> {
    try {
      const dbType = DatabaseClient.getInstance().type;
      const options = DatabaseClient.getInstance().getOptions();

      let connector: IConnector;
      if (dbType === "postgres") {
        connector = new PostgresConnector();
      } else {
        // mysql, mariadb
        connector = new MySqlConnector();
      }

      // 노드 설정으로 연결 (원본 옵션의 host/port/username/password/database를 오버라이드)
      await connector.connect({
        ...options,
        host: nodeConfig.host,
        port: nodeConfig.port,
        username: nodeConfig.username,
        password: nodeConfig.password,
        database: nodeConfig.database,
      });

      this.connection = connector;

      if (dbType === "postgres") {
        this.dataSource = new PostgresDataSource(this.connection);
      } else if (dbType === "sqlite") {
        this.dataSource = new SqliteDataSource(this.connection);
      } else if (dbType === "mysql" || dbType === "mariadb") {
        this.dataSource = new MySqlDataSource(this.connection);
      } else {
        throw new Error(`Unsupported database type: ${dbType}`);
      }

      await this.dataSource.createConnection();
    } catch (error: unknown) {
      throw new DatabaseConnectionFailedError();
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
