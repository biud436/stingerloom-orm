import { MigrationRunner } from "./MigrationRunner";

/**
 * Migration runner for PostgreSQL.
 * Uses double-quote (") identifier wrapping and a SERIAL primary key.
 */
export class PostgresMigrationRunner extends MigrationRunner {
  protected wrapIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  protected autoIncrementPkDefinition(): string {
    return "SERIAL PRIMARY KEY";
  }
}
