import { MigrationRunner } from "./MigrationRunner";

/**
 * SQLite용 마이그레이션 러너.
 * 큰따옴표(") 식별자 래핑과 INTEGER PRIMARY KEY AUTOINCREMENT를 사용합니다.
 */
export class SqliteMigrationRunner extends MigrationRunner {
  protected wrapIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  protected autoIncrementPkDefinition(): string {
    return "INTEGER PRIMARY KEY AUTOINCREMENT";
  }
}
