import { MigrationRunner } from "./MigrationRunner";

/**
 * MySQL/MariaDB용 마이그레이션 러너.
 * 백틱(`) 식별자 래핑과 AUTO_INCREMENT PK를 사용합니다.
 */
export class MySqlMigrationRunner extends MigrationRunner {
  protected wrapIdentifier(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  protected autoIncrementPkDefinition(): string {
    return "INT AUTO_INCREMENT PRIMARY KEY";
  }
}
