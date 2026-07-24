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
   * Returns the type of the default connection (kept for backward compatibility).
   */
  public get type(): string | undefined {
    return this.connectionsType.get("default");
  }

  /**
   * Creates a connector and connects to the database.
   * @param options connection options
   * @param name connection name (default: "default")
   */
  public async connect(
    options: DatabaseClientOptions,
    name = "default",
  ): Promise<IConnector> {
    const { type } = options;

    // Re-connecting under a name that is still registered replaces the
    // connection every consumer of that name routes through — a second
    // EntityManager registered without a distinct connectionName would
    // silently redirect the first one to the new database.
    const previous = this.connectors.get(name);
    if (previous) {
      this.logger.warn(
        `Connection '${name}' is already registered and will be replaced. ` +
        `Every EntityManager using '${name}' now routes to the new database. ` +
        `If this is a second EntityManager, pass a distinct connectionName to ` +
        `register() instead, or close() the existing connection first.`,
      );
      try {
        await previous.close();
      } catch {
        // best effort — the old connector may already be closed
      }
    }

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
   * Dynamically creates a connector instance for the given database type.
   * Drivers that are not used are not loaded.
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
   * Retries the connection with exponential backoff.
   * Actual delay: backoffMs * 2^(attempt-1).
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
   * Returns the connection with the given name.
   * @param name connection name (default: "default")
   */
  public getConnection(name = "default"): IConnector {
    const connector = this.connectors.get(name);
    if (!connector) {
      if (name === "default") {
        throw new DatabaseNotConnectedError();
      }
      throw new Exception(`Connection '${name}' was not found.`, 500);
    }

    return connector;
  }

  /**
   * Returns the connection options for the given name.
   * @param name connection name (default: "default")
   */
  public getOptions(name = "default"): DatabaseClientOptions {
    const options = this.connectionsOptions.get(name);
    if (!options) {
      throw new Exception(
        name === "default"
          ? "No connection options are registered."
          : `No options found for connection '${name}'.`,
        500,
      );
    }

    return options;
  }

  /**
   * Returns the database type of the given connection.
   * @param name connection name (default: "default")
   */
  public getType(name = "default"): string | undefined {
    return this.connectionsType.get(name);
  }

  /**
   * Returns the list of registered connection names.
   */
  public getRegisteredNames(): string[] {
    return Array.from(this.connectors.keys());
  }

  /**
   * Checks whether a connection with the given name is registered.
   */
  public hasConnection(name = "default"): boolean {
    return this.connectors.has(name);
  }

  /**
   * Closes connections.
   * @param name connection name; when omitted, every connection is closed.
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
