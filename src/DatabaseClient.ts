/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { DatabaseNotConnectedError } from "./errors/DatabaseNotConnectedError";
import { MySqlConnector } from "./dialects/mysql/MySqlConnector";
import { PostgresConnector } from "./dialects/postgres/PostgresConnector";
import { SqliteConnector } from "./dialects/sqlite/SqliteConnector";
import { MssqlConnector } from "./dialects/mssql/MssqlConnector";
import { DatabaseClientOptions } from "./core/DatabaseClientOptions";
import { IConnector } from "./core/IConnector";
import { NotSupportedDatabaseTypeError } from "./errors/NotSupportedDatabaseTypeError";
import { Exception } from "./errors";
import { Logger } from "./utils/Logger";

export class DatabaseClient {
  private static instance: DatabaseClient;
  private connector?: IConnector;
  private options?: DatabaseClientOptions;
  public type?: string;
  private readonly logger = new Logger(DatabaseClient.name);

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

  /**
   * 커넥터를 생성하고 데이터베이스에 연결합니다.
   * retry 옵션이 설정되어 있으면 지수 백오프로 재시도합니다.
   */
  public async connect(options: DatabaseClientOptions): Promise<IConnector> {
    const { type } = options;

    this.type = type;
    this.options = options;

    const connector = this.createConnector(type);
    this.connector = connector;

    if (options.retry) {
      await this.connectWithRetry(connector, options);
    } else {
      await connector.connect(options);
    }

    return this.connector;
  }

  /**
   * DB 타입에 맞는 커넥터 인스턴스를 생성합니다.
   */
  private createConnector(type: string): IConnector {
    switch (type) {
      case "mariadb":
      case "mysql":
        return new MySqlConnector();
      case "postgres":
        return new PostgresConnector();
      case "sqlite":
        return new SqliteConnector();
      case "mssql":
        return new MssqlConnector();
      default:
        throw new NotSupportedDatabaseTypeError();
    }
  }

  /**
   * 지수 백오프를 사용하여 연결을 재시도합니다.
   * 실제 지연: backoffMs * 2^(attempt-1)
   */
  private async connectWithRetry(
    connector: IConnector,
    options: DatabaseClientOptions,
  ): Promise<void> {
    const { maxAttempts, backoffMs } = options.retry!;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await connector.connect(options);
        return;
      } catch (error: unknown) {
        lastError = error;
        if (attempt < maxAttempts) {
          const delay = backoffMs * Math.pow(2, attempt - 1);
          this.logger.warn(
            `Connection attempt ${attempt}/${maxAttempts} failed. Retrying in ${delay}ms...`,
          );
          await this.sleep(delay);
        }
      }
    }

    this.logger.error(
      `All ${maxAttempts} connection attempts failed.`,
    );
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
