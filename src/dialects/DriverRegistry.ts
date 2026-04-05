/* eslint-disable @typescript-eslint/no-explicit-any */
import { ISqlDriver } from "./SqlDriver";
import { IDataSource } from "./IDataSource";

/**
 * Factory functions for creating a driver and data source for a given database type.
 */
export interface DriverFactory {
  createDriver(connector: any, dbType: string, schema?: string): ISqlDriver;
  createDataSource(connector: any): IDataSource;
}

/**
 * Global registry for database driver factories.
 *
 * Built-in drivers (mysql, mariadb, postgres, sqlite) are registered
 * automatically by EntityManager. Users can register custom drivers
 * for additional databases (e.g. Oracle, MSSQL, CockroachDB).
 *
 * @example
 * ```ts
 * import { DriverRegistry } from "@stingerloom/orm";
 *
 * DriverRegistry.register("oracle", {
 *   createDriver: (connector, dbType) => new OracleDriver(connector),
 *   createDataSource: (connector) => new OracleDataSource(connector),
 * });
 *
 * // Then use with EntityManager
 * await em.register({ type: "oracle", ... });
 * ```
 */
export class DriverRegistry {
  private static readonly factories = new Map<string, DriverFactory>();

  /**
   * Register a driver factory for a database type.
   * Overwrites any existing registration for the same type.
   */
  static register(dbType: string, factory: DriverFactory): void {
    DriverRegistry.factories.set(dbType, factory);
  }

  /**
   * Unregister a driver factory.
   */
  static unregister(dbType: string): void {
    DriverRegistry.factories.delete(dbType);
  }

  /**
   * Check if a driver factory is registered for the given type.
   */
  static has(dbType: string): boolean {
    return DriverRegistry.factories.has(dbType);
  }

  /**
   * Get the driver factory for the given type.
   */
  static get(dbType: string): DriverFactory | undefined {
    return DriverRegistry.factories.get(dbType);
  }

  /**
   * Get all registered database type names.
   */
  static getRegisteredTypes(): string[] {
    return [...DriverRegistry.factories.keys()];
  }

  /**
   * Remove all registered factories. Primarily for testing.
   */
  static clear(): void {
    DriverRegistry.factories.clear();
  }
}
