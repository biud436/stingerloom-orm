import { MigrationRunner } from "./MigrationRunner";

/**
 * Migration runner for MySQL/MariaDB.
 * Uses backtick (`) identifier wrapping and an AUTO_INCREMENT primary key.
 */
export class MySqlMigrationRunner extends MigrationRunner {
  protected wrapIdentifier(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  protected autoIncrementPkDefinition(): string {
    return "INT AUTO_INCREMENT PRIMARY KEY";
  }
}
