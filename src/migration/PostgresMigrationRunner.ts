import { MigrationRunner } from "./MigrationRunner";
import { sqlStringLiteral } from "../utils/escapeSqlLiteral";

/**
 * Migration runner for PostgreSQL.
 * Uses double-quote (") identifier wrapping and a SERIAL primary key.
 */
export class PostgresMigrationRunner extends MigrationRunner {
  protected wrapIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  protected stringLiteral(value: string): string {
    return sqlStringLiteral(value, "postgres");
  }

  protected autoIncrementPkDefinition(): string {
    return "SERIAL PRIMARY KEY";
  }
}
