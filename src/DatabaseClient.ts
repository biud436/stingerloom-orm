/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { DatabaseNotConnectedError } from "./errors/DatabaseNotConnectedError";
import { MySqlConnector } from "./dialects/mysql/MySqlConnector";
import { PostgresConnector } from "./dialects/postgres/PostgresConnector";
import { SqliteConnector } from "./dialects/sqlite/SqliteConnector";
import { DatabaseClientOptions } from "./core/DatabaseClientOptions";
import { IConnector } from "./core/IConnector";
import { NotSupportedDatabaseTypeError } from "./errors/NotSupportedDatabaseTypeError";
import { Exception } from "./errors";

export class DatabaseClient {
  private static instance: DatabaseClient;
  private connector?: IConnector;
  private options?: DatabaseClientOptions;
  public type?: string;

  private constructor() {}

  public static getInstance(): DatabaseClient {
    if (!DatabaseClient.instance) {
      DatabaseClient.instance = new DatabaseClient();
    }

    return DatabaseClient.instance;
  }

  public getConnection(): IConnector {
    if (!this.connector) {
      throw new DatabaseNotConnectedError();
    }

    return this.connector;
  }

  public async connect(options: DatabaseClientOptions): Promise<IConnector> {
    const { type } = options;

    this.type = type;
    this.options = options;

    switch (type) {
      case "mariadb":
      case "mysql":
        this.connector = new MySqlConnector();
        await this.connector.connect(options);
        break;
      case "postgres":
        this.connector = new PostgresConnector();
        await this.connector.connect(options);
        break;
      case "sqlite":
        this.connector = new SqliteConnector();
        await this.connector.connect(options);
        break;
      default:
        throw new NotSupportedDatabaseTypeError();
    }

    return this.connector;
  }

  public async close(): Promise<void> {
    if (!this.connector) {
      return;
    }

    await this.connector.close();
  }

  public getOptions(): DatabaseClientOptions {
    if (!this.options) {
      throw new Exception("옵션이 존재하지 않습니다.", 500);
    }

    return this.options;
  }
}
