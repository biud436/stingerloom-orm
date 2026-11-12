import { MigrationRunner } from "./MigrationRunner";
import { sqlStringLiteral } from "../utils/escapeSqlLiteral";

/**
 * Migration runner for MySQL/MariaDB.
 * Uses backtick (`) identifier wrapping and an AUTO_INCREMENT primary key.
 *
 * MySQL commits each schema change as it runs, so a migration runs one
 * statement at a time unless it sets `transaction = true`.
 */
export class MySqlMigrationRunner extends MigrationRunner {
  protected wrapIdentifier(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  protected stringLiteral(value: string): string {
    return sqlStringLiteral(value, "mysql");
  }

  protected autoIncrementPkDefinition(): string {
    return "INT AUTO_INCREMENT PRIMARY KEY";
  }

  protected outsideTransactionByDefault(): string | undefined {
    return "MySQL commits each schema change as it runs";
  }
}
