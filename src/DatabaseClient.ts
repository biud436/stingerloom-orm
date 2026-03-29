/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { DatabaseNotConnectedError } from "./errors/DatabaseNotConnectedError";
import { DatabaseClientOptions } from "./core/DatabaseClientOptions";
import { IConnector } from "./core/IConnector";
import { NotSupportedDatabaseTypeError } from "./errors/NotSupportedDatabaseTypeError";
import { Exception } from "./errors";
import { Logger } from "./utils/Logger";

export class DatabaseClient {
  private static instance: DatabaseClient;

  /** Named connection registry */
  private readonly connectors: Map<string, IConnector> = new Map();
  private readonly connectionsOptions: Map<string, DatabaseClientOptions> =
    new Map();
  private readonly connectionsType: Map<string, string> = new Map();

  private readonly logger = new Logger(DatabaseClient.name);

  private constructor() {}

  public static getInstance(): DatabaseClient {
    if (!DatabaseClient.instance) {
      DatabaseClient.instance = new DatabaseClient();
    }

    return DatabaseClient.instance;
  }

  /**
   * 기본(default) 연결의 타입을 반환합니다. (하위 호환)
   */
  public get type(): string | undefined {
    return this.connectionsType.get("default");
  }

  /**
   * 커넥터를 생성하고 데이터베이스에 연결합니다.
   * @param options 연결 옵션
   * @param name 연결 이름 (기본값: 'default')
   */
  public async connect(
    options: DatabaseClientOptions,
    name = "default",
  ): Promise<IConnector> {
    const { type } = options;

    this.connectionsType.set(name, type);
    this.connectionsOptions.set(name, options);

    const connector = await this.createConnector(type);
    this.connectors.set(name, connector);

    if (options.retry) {
      await this.connectWithRetry(connector, options);
    } else {
      await connector.connect(options);
    }

    return connector;
  }

  /**
   * DB 타입에 맞는 커넥터 인스턴스를 동적으로 생성합니다.
   * 사용하지 않는 드라이버는 로드하지 않습니다.
   */
  private async createConnector(type: string): Promise<IConnector> {
    switch (type) {
      case "mariadb":
      case "mysql": {
        const { MySqlConnector } = await import(
          "./dialects/mysql/MySqlConnector"
        );
        return new MySqlConnector();
      }
      case "postgres": {
        const { PostgresConnector } = await import(
          "./dialects/postgres/PostgresConnector"
        );
        return new PostgresConnector();
      }
      case "sqlite": {
        const { SqliteConnector } = await import(
          "./dialects/sqlite/SqliteConnector"
        );
        return new SqliteConnector();
      }
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

    this.logger.error(`All ${maxAttempts} connection attempts failed.`);
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 지정된 이름의 연결을 반환합니다.
   * @param name 연결 이름 (기본값: 'default')
   */
  public getConnection(name = "default"): IConnector {
    const connector = this.connectors.get(name);
    if (!connector) {
      if (name === "default") {
        throw new DatabaseNotConnectedError();
      }
      throw new Exception(`연결 '${name}'을 찾을 수 없습니다.`, 500);
    }

    return connector;
  }

  /**
   * 지정된 이름의 연결 옵션을 반환합니다.
   * @param name 연결 이름 (기본값: 'default')
   */
  public getOptions(name = "default"): DatabaseClientOptions {
    const options = this.connectionsOptions.get(name);
    if (!options) {
      throw new Exception(
        name === "default"
          ? "옵션이 존재하지 않습니다."
          : `연결 '${name}'의 옵션을 찾을 수 없습니다.`,
        500,
      );
    }

    return options;
  }

  /**
   * 지정된 이름의 연결 타입(DB 종류)을 반환합니다.
   * @param name 연결 이름 (기본값: 'default')
   */
  public getType(name = "default"): string | undefined {
    return this.connectionsType.get(name);
  }

  /**
   * 등록된 모든 연결 이름 목록을 반환합니다.
   */
  public getRegisteredNames(): string[] {
    return Array.from(this.connectors.keys());
  }

  /**
   * 특정 연결이 등록되어 있는지 확인합니다.
   */
  public hasConnection(name = "default"): boolean {
    return this.connectors.has(name);
  }

  /**
   * 연결을 종료합니다.
   * @param name 연결 이름. 미지정 시 모든 연결을 종료합니다.
   */
  public async close(name?: string): Promise<void> {
    if (name) {
      const connector = this.connectors.get(name);
      if (connector) {
        await connector.close();
        this.connectors.delete(name);
        this.connectionsOptions.delete(name);
        this.connectionsType.delete(name);
      }
      return;
    }

    // Close all connections
    for (const [connName, connector] of this.connectors) {
      await connector.close();
      this.connectors.delete(connName);
      this.connectionsOptions.delete(connName);
      this.connectionsType.delete(connName);
    }
  }
}
