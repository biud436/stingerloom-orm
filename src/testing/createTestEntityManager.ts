/* eslint-disable @typescript-eslint/no-explicit-any */
import { EntityManager } from "../core/EntityManager";
import { DatabaseClientOptions } from "../core/DatabaseClientOptions";
import { ClazzType } from "../utils/types";

/**
 * Options for creating a test EntityManager.
 */
export interface TestEntityManagerOptions {
  /** Entity classes to register. */
  entities: ClazzType<any>[];
  /**
   * Database type. Defaults to "sqlite".
   * When "sqlite", uses in-memory SQLite (requires better-sqlite3).
   */
  type?: "sqlite" | "mysql" | "postgres";
  /** Synchronize mode (default: true). */
  synchronize?: boolean | "safe" | "dry-run";
  /** Connection name (default: "test"). */
  connectionName?: string;
  /** Additional database options (host, port, etc. for non-sqlite). */
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
}

/**
 * Creates a fully configured EntityManager with SQLite in-memory
 * for testing purposes. The database is disposable and requires
 * no external service.
 *
 * @example
 * ```ts
 * import { createTestEntityManager } from "@stingerloom/orm/testing";
 *
 * const em = await createTestEntityManager({
 *   entities: [User, Post],
 * });
 *
 * const user = await em.save(User, { name: "test" });
 * ```
 */
export async function createTestEntityManager(
  options: TestEntityManagerOptions,
): Promise<EntityManager> {
  const em = new EntityManager();
  const dbType = options.type ?? "sqlite";

  let dbOptions: DatabaseClientOptions;

  if (dbType === "sqlite") {
    dbOptions = {
      type: "sqlite",
      database: options.database ?? ":memory:",
      entities: options.entities,
      synchronize: options.synchronize ?? true,
    };
  } else {
    dbOptions = {
      type: dbType,
      host: options.host ?? "localhost",
      port: options.port ?? (dbType === "postgres" ? 5432 : 3306),
      username: options.username ?? "root",
      password: options.password ?? "",
      database: options.database ?? "test",
      entities: options.entities,
      synchronize: options.synchronize ?? true,
    };
  }

  await em.register(dbOptions, options.connectionName ?? "test");

  return em;
}
