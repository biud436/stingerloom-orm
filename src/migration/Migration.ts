/* eslint-disable @typescript-eslint/no-explicit-any */
import { ISqlDriver } from "../dialects/SqlDriver";

/**
 * Migration execution context.
 * The up/down methods can run DDL through the driver or execute arbitrary
 * SQL via the query function. In a migration that runs in a transaction,
 * both run on the transaction's connection.
 */
export interface MigrationContext {
  driver: ISqlDriver;
  query: (sql: string) => Promise<any>;
}

/**
 * Settings a migration may declare, as a field or a getter.
 */
// Declared on an interface merged with the class, not in the class body, so
// a subclass can set it with a field or a getter alike.
export interface Migration {
  /**
   * Whether the runner applies this migration in a transaction, together
   * with its row in the tracking table, so a failure part-way leaves
   * neither behind. Left unset, PostgreSQL and SQLite do and MySQL does not
   * (MySQL commits each schema change as it runs).
   *
   * Set `false` for statements that cannot run in a transaction, such as
   * PostgreSQL's `CREATE INDEX CONCURRENTLY` or SQLite's
   * `PRAGMA foreign_keys`. Set `true` on MySQL for a migration that only
   * changes data.
   *
   * ```ts
   * class AddEmailIndex extends Migration {
   *   readonly transaction = false;
   *   // ...
   * }
   * ```
   */
  readonly transaction?: boolean;
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
