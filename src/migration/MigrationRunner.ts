/* eslint-disable @typescript-eslint/no-explicit-any */
import { ISqlDriver } from "../dialects/SqlDriver";
import { Logger } from "../utils";
import { Migration, MigrationContext } from "./Migration";

/**
 * 마이그레이션 실행 결과.
 */
export interface MigrationResult {
  name: string;
  direction: "up" | "down";
  success: boolean;
  error?: string;
}

/**
 * __migrations 테이블에 기록되는 행의 형태.
 */
export interface MigrationRecord {
  name: string;
  executed_at: string;
}

/**
 * MigrationRunner에 주입되는 쿼리 실행 인터페이스.
 * TransactionSessionManager에 의존하지 않고 테스트 가능하도록 추상화.
 */
export interface MigrationQueryRunner {
  query: (sql: string) => Promise<any>;
}

/**
 * 마이그레이션 러너.
 * 미실행 마이그레이션을 순서대로 실행하고 __migrations 테이블에 기록합니다.
 * MySQL/PostgreSQL 드라이버 모두 지원합니다.
 */
export class MigrationRunner {
  private readonly logger = new Logger(MigrationRunner.name);
  private readonly migrations: Migration[];
  private readonly driver: ISqlDriver;
  private readonly queryRunner: MigrationQueryRunner;
  private readonly tableName = "__migrations";

  constructor(
    migrations: Migration[],
    driver: ISqlDriver,
    queryRunner: MigrationQueryRunner,
  ) {
    this.migrations = migrations;
    this.driver = driver;
    this.queryRunner = queryRunner;
  }

  /**
   * __migrations 추적 테이블을 생성합니다.
   * 이미 존재하면 아무 작업도 하지 않습니다.
   */
  async ensureMigrationTable(): Promise<void> {
    const isMySql = this.driver.isMySqlFamily();

    if (isMySql) {
      await this.queryRunner.query(
        `CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (` +
          `\`id\` INT AUTO_INCREMENT PRIMARY KEY, ` +
          `\`name\` VARCHAR(255) NOT NULL UNIQUE, ` +
          `\`executed_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP` +
          `)`,
      );
    } else {
      // PostgreSQL / SQLite
      await this.queryRunner.query(
        `CREATE TABLE IF NOT EXISTS "${this.tableName}" (` +
          `"id" SERIAL PRIMARY KEY, ` +
          `"name" VARCHAR(255) NOT NULL UNIQUE, ` +
          `"executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP` +
          `)`,
      );
    }
  }

  /**
   * 이미 실행된 마이그레이션 이름 목록을 조회합니다.
   */
  async getExecutedMigrations(): Promise<string[]> {
    const isMySql = this.driver.isMySqlFamily();
    const quote = isMySql ? "`" : '"';

    const result = await this.queryRunner.query(
      `SELECT ${quote}name${quote} FROM ${quote}${this.tableName}${quote} ORDER BY ${quote}id${quote} ASC`,
    );

    // 드라이버별 결과 형태 정규화
    const rows = this.normalizeRows(result);
    return rows.map((row: any) => row.name);
  }

  /**
   * 미실행 마이그레이션을 순서대로 실행합니다.
   */
  async runAll(): Promise<MigrationResult[]> {
    await this.ensureMigrationTable();
    const executed = await this.getExecutedMigrations();
    const pending = this.migrations.filter(
      (m) => !executed.includes(m.name),
    );

    const results: MigrationResult[] = [];

    for (const migration of pending) {
      const result = await this.runUp(migration);
      results.push(result);
      if (!result.success) {
        break;
      }
    }

    return results;
  }

  /**
   * 단일 마이그레이션을 적용합니다.
   */
  async runUp(migration: Migration): Promise<MigrationResult> {
    const context = this.createContext();

    try {
      this.logger.info(`Running migration: ${migration.name}`);
      await migration.up(context);
      await this.recordMigration(migration.name);
      this.logger.info(`Migration completed: ${migration.name}`);
      return { name: migration.name, direction: "up", success: true };
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error(`Migration failed: ${migration.name} - ${error}`);
      return { name: migration.name, direction: "up", success: false, error };
    }
  }

  /**
   * 단일 마이그레이션을 되돌립니다.
   */
  async runDown(migration: Migration): Promise<MigrationResult> {
    const context = this.createContext();

    try {
      this.logger.info(`Reverting migration: ${migration.name}`);
      await migration.down(context);
      await this.removeMigrationRecord(migration.name);
      this.logger.info(`Migration reverted: ${migration.name}`);
      return { name: migration.name, direction: "down", success: true };
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `Migration revert failed: ${migration.name} - ${error}`,
      );
      return { name: migration.name, direction: "down", success: false, error };
    }
  }

  /**
   * 가장 최근에 실행된 마이그레이션을 되돌립니다.
   */
  async revertLast(): Promise<MigrationResult | null> {
    await this.ensureMigrationTable();
    const executed = await this.getExecutedMigrations();

    if (executed.length === 0) {
      this.logger.info("No migrations to revert.");
      return null;
    }

    const lastName = executed[executed.length - 1];
    const migration = this.migrations.find((m) => m.name === lastName);

    if (!migration) {
      const error = `Migration "${lastName}" not found in registered migrations.`;
      this.logger.error(error);
      return { name: lastName, direction: "down", success: false, error };
    }

    return this.runDown(migration);
  }

  /**
   * 미실행 마이그레이션을 name 순서대로 실행합니다.
   * runAll()의 별칭으로, 외부에서 마이그레이션 목록을 전달하여 실행할 수 있습니다.
   *
   * @param migrations 실행할 마이그레이션 목록. 생략 시 생성자에서 전달된 전체 목록 사용.
   */
  async run(migrations?: Migration[]): Promise<MigrationResult[]> {
    if (migrations) {
      const originalMigrations = this.migrations;
      (this as any).migrations = migrations;
      const results = await this.runAll();
      (this as any).migrations = originalMigrations;
      return results;
    }
    return this.runAll();
  }

  /**
   * 최근 n개의 마이그레이션을 되돌립니다.
   *
   * @param n 되돌릴 마이그레이션 수. 기본값 1.
   */
  async rollback(n: number = 1): Promise<MigrationResult[]> {
    await this.ensureMigrationTable();
    const executed = await this.getExecutedMigrations();
    const results: MigrationResult[] = [];

    const toRevert = executed.slice(-n).reverse();

    for (const name of toRevert) {
      const migration = this.migrations.find((m) => m.name === name);
      if (!migration) {
        const error = `Migration "${name}" not found in registered migrations.`;
        this.logger.error(error);
        results.push({ name, direction: "down", success: false, error });
        break;
      }
      const result = await this.runDown(migration);
      results.push(result);
      if (!result.success) {
        break;
      }
    }

    return results;
  }

  /**
   * 마이그레이션 상태를 반환합니다.
   * 실행됨/미실행 목록을 각각 반환합니다.
   */
  async status(): Promise<{
    executed: string[];
    pending: string[];
  }> {
    await this.ensureMigrationTable();
    const executed = await this.getExecutedMigrations();
    const pending = this.migrations
      .filter((m) => !executed.includes(m.name))
      .map((m) => m.name);
    return { executed, pending };
  }

  /**
   * 미실행 마이그레이션 목록을 반환합니다.
   */
  async getPendingMigrations(): Promise<Migration[]> {
    await this.ensureMigrationTable();
    const executed = await this.getExecutedMigrations();
    return this.migrations.filter((m) => !executed.includes(m.name));
  }

  private createContext(): MigrationContext {
    return {
      driver: this.driver,
      query: (sql: string) => this.queryRunner.query(sql),
    };
  }

  private async recordMigration(name: string): Promise<void> {
    const isMySql = this.driver.isMySqlFamily();
    const quote = isMySql ? "`" : '"';
    await this.queryRunner.query(
      `INSERT INTO ${quote}${this.tableName}${quote} (${quote}name${quote}) VALUES ('${name.replace(/'/g, "''")}')`,
    );
  }

  private async removeMigrationRecord(name: string): Promise<void> {
    const isMySql = this.driver.isMySqlFamily();
    const quote = isMySql ? "`" : '"';
    await this.queryRunner.query(
      `DELETE FROM ${quote}${this.tableName}${quote} WHERE ${quote}name${quote} = '${name.replace(/'/g, "''")}'`,
    );
  }

  /**
   * 드라이버별 쿼리 결과를 행 배열로 정규화합니다.
   * MySQL: { results: [...], fields: [...] }
   * PostgreSQL: { rows: [...] } 또는 직접 배열
   */
  private normalizeRows(result: any): any[] {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (result.results && Array.isArray(result.results)) return result.results;
    if (result.rows && Array.isArray(result.rows)) return result.rows;
    return [];
  }
}
