import { MigrationRunner } from "./MigrationRunner";

/** A statement that turns SQLite's foreign key enforcement on or off. */
const SET_FOREIGN_KEYS = /\bPRAGMA\s+(?:[\w"`[\]]+\s*\.\s*)?["`[]?foreign_keys["`\]]?\s*[=(]/i;

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

  /**
   * SQLite ignores `PRAGMA foreign_keys` inside a transaction. A table
   * rebuild that turns foreign keys off there keeps them on, and dropping
   * the old table then deletes its rows first, running each ON DELETE
   * action of the tables that reference it.
   */
  protected refuseInTransaction(sql: string): string | undefined {
    if (!SET_FOREIGN_KEYS.test(sql)) return undefined;
    return (
      "PRAGMA foreign_keys has no effect inside a transaction, and this migration runs in one. " +
      "Set `transaction = false` on the migration to turn foreign keys off around a table rebuild, " +
      "or use PRAGMA defer_foreign_keys = ON inside the transaction."
    );
  }
}
