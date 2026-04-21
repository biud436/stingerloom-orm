import { MigrationRunner } from "./MigrationRunner";

/**
 * Migration runner for SQLite.
 * Uses double-quote (") identifier wrapping and INTEGER PRIMARY KEY AUTOINCREMENT.
 */
export class SqliteMigrationRunner extends MigrationRunner {
  protected wrapIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  protected autoIncrementPkDefinition(): string {
    return "INTEGER PRIMARY KEY AUTOINCREMENT";
  }
}
