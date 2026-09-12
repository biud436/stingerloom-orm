import type { ISqlDriver } from "../../dialects/SqlDriver";
import type { IDataSource } from "../../dialects/IDataSource";
import type { IDatabaseType } from "../../dialects/mysql/MySqlConnector";
import type { IConnector } from "../../core/IConnector";
import { NotSupportedDatabaseTypeError } from "../../errors/NotSupportedDatabaseTypeError";

/** The driver + data source an EntityManager binds to one connector. */
export interface ResolvedDriverPair {
  driver: ISqlDriver;
  dataSource: IDataSource;
}

/**
 * Picks the SQL driver and data source for a connector that `DatabaseClient`
 * has opened: a `DriverRegistry` factory when one is registered for the
 * type, otherwise the built-in MySQL / MariaDB / PostgreSQL / SQLite pair.
 *
 * Dialect modules are loaded lazily so a process that only ever talks to
 * SQLite never requires `mysql2` or `pg`.
 *
 * @internal Package-internal — not a public API.
 */
export async function resolveDriverPair(
  dbType: IDatabaseType,
  connector: IConnector,
  schema?: string,
): Promise<ResolvedDriverPair> {
  // Check DriverRegistry first for custom drivers
  const { DriverRegistry } = await import("../../dialects/DriverRegistry");
  const customFactory = DriverRegistry.get(dbType);

  if (customFactory) {
    return {
      driver: customFactory.createDriver(connector, dbType, schema),
      dataSource: customFactory.createDataSource(connector),
    };
  }

  // Built-in drivers
  switch (dbType) {
    case "mariadb":
    case "mysql": {
      const { MySqlDriver } = await import("../../dialects/mysql/MySqlDriver");
      const { MySqlDataSource } = await import(
        "../../dialects/mysql/MySqlDataSource"
      );
      return {
        driver: new MySqlDriver(connector, dbType),
        dataSource: new MySqlDataSource(connector),
      };
    }
    case "postgres": {
      const { PostgresDriver } = await import(
        "../../dialects/postgres/PostgresDriver"
      );
      const { PostgresDataSource } = await import(
        "../../dialects/postgres/PostgresDataSource"
      );
      return {
        driver: new PostgresDriver(connector, dbType, schema),
        dataSource: new PostgresDataSource(connector),
      };
    }
    case "sqlite": {
      const { SqliteDriver } = await import(
        "../../dialects/sqlite/SqliteDriver"
      );
      const { SqliteDataSource } = await import(
        "../../dialects/sqlite/SqliteDataSource"
      );
      return {
        driver: new SqliteDriver(connector),
        dataSource: new SqliteDataSource(connector),
      };
    }
    default:
      throw new NotSupportedDatabaseTypeError();
  }
}
