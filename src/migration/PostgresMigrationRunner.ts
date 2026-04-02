import { MigrationRunner } from "./MigrationRunner";

/**
 * PostgreSQL용 마이그레이션 러너.
 * 큰따옴표(") 식별자 래핑과 SERIAL PK를 사용합니다.
 */
export class PostgresMigrationRunner extends MigrationRunner {
  protected wrapIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  protected autoIncrementPkDefinition(): string {
    return "SERIAL PRIMARY KEY";
  }
}
