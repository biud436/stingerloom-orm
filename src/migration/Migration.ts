/* eslint-disable @typescript-eslint/no-explicit-any */
import { ISqlDriver } from "../dialects/SqlDriver";

/**
 * Migration execution context.
 * The up/down methods can run DDL through the driver or execute arbitrary
 * SQL via the query function.
 */
export interface MigrationContext {
  driver: ISqlDriver;
  query: (sql: string) => Promise<any>;
}

/**
 * Abstract Migration class.
 * All migrations extend this class and implement up/down.
 */
export abstract class Migration {
  /**
   * Migration name. Defaults to the class name.
   */
  get name(): string {
    return this.constructor.name;
  }

  /**
   * Applies the migration (schema changes, etc.).
   */
  abstract up(context: MigrationContext): Promise<void>;

  /**
   * Reverts the migration (restores schema, etc.).
   */
  abstract down(context: MigrationContext): Promise<void>;
}
