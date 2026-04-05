/* eslint-disable @typescript-eslint/no-explicit-any */
import { ISqlDriver } from "../dialects/SqlDriver";
import { Logger } from "../utils";
import { Migration, MigrationContext } from "./Migration";
import { AdvisoryLockError } from "../errors/AdvisoryLockError";

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
 * MySQL/PostgreSQL/SQLite 드라이버 모두 지원합니다.
 *
 * 이 클래스는 abstract base class로, dialect별 구체 구현체
 * (MySqlMigrationRunner, PostgresMigrationRunner, SqliteMigrationRunner)를
 * 통해 사용합니다.
 */
/**
 * Lifecycle hooks for migration execution.
 */
export interface MigrationHooks {
  /** Called before any migration runs. */
  beforeAll?(context: MigrationContext): Promise<void> | void;
  /** Called after all migrations complete. */
  afterAll?(context: MigrationContext, results: MigrationResult[]): Promise<void> | void;
  /** Called before each individual migration. */
  beforeEach?(migration: Migration, context: MigrationContext): Promise<void> | void;
  /** Called after each individual migration succeeds. */
  afterEach?(migration: Migration, context: MigrationContext, durationMs: number): Promise<void> | void;
  /** Called when a migration fails. */
  onError?(migration: Migration, error: Error, context: MigrationContext): Promise<void> | void;
}

export interface MigrationRunnerOptions {
  lockId?: string;
  lockTimeoutMs?: number;
  /** Custom migration tracking table name (default: "__migrations"). */
  tableName?: string;
  /** Lifecycle hooks for migration execution. */
  hooks?: MigrationHooks;
}

export abstract class MigrationRunner {
  private readonly logger = new Logger(MigrationRunner.name);
  private readonly migrations: Migration[];
  protected readonly driver: ISqlDriver;
  private readonly queryRunner: MigrationQueryRunner;
  private readonly tableName: string;
  private readonly lockId: string;
  private readonly lockTimeoutMs: number;
  private readonly hooks: MigrationHooks;

  constructor(
    migrations: Migration[],
    driver: ISqlDriver,
    queryRunner: MigrationQueryRunner,
    options?: MigrationRunnerOptions,
  ) {
    this.migrations = migrations;
    this.driver = driver;
    this.queryRunner = queryRunner;
    this.lockId = options?.lockId ?? "stingerloom_migration_lock";
    this.lockTimeoutMs = options?.lockTimeoutMs ?? 10000;
    this.tableName = options?.tableName ?? "__migrations";
    this.hooks = options?.hooks ?? {};
  }

  /**
   * 식별자를 dialect별 문자로 감싸서 반환합니다.
   * MySQL: backtick (`), PostgreSQL/SQLite: double-quote (")
   */
  protected abstract wrapIdentifier(name: string): string;

  /**
   * 자동 증가 PK 컬럼 정의를 반환합니다.
   * MySQL: "INT AUTO_INCREMENT PRIMARY KEY"
   * PostgreSQL: "SERIAL PRIMARY KEY"
   * SQLite: "INTEGER PRIMARY KEY AUTOINCREMENT"
   */
  protected abstract autoIncrementPkDefinition(): string;

  /**
   * __migrations 추적 테이블을 생성합니다.
   * 이미 존재하면 아무 작업도 하지 않습니다.
   */
  async ensureMigrationTable(): Promise<void> {
    const w = (n: string) => this.wrapIdentifier(n);
    await this.queryRunner.query(
      `CREATE TABLE IF NOT EXISTS ${w(this.tableName)} (` +
        `${w("id")} ${this.autoIncrementPkDefinition()}, ` +
        `${w("name")} VARCHAR(255) NOT NULL UNIQUE, ` +
        `${w("executed_at")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP` +
        `)`,
    );
  }

  /**
   * 이미 실행된 마이그레이션 이름 목록을 조회합니다.
   */
  async getExecutedMigrations(): Promise<string[]> {
    const w = (n: string) => this.wrapIdentifier(n);

    const result = await this.queryRunner.query(
      `SELECT ${w("name")} FROM ${w(this.tableName)} ORDER BY ${w("id")} ASC`,
    );

    // 드라이버별 결과 형태 정규화
    const rows = this.normalizeRows(result);
    return rows.map((row: any) => row.name);
  }

  /**
   * 미실행 마이그레이션을 순서대로 실행합니다.
   * Advisory lock을 사용하여 동시 실행을 방지합니다.
   */
  async runAll(): Promise<MigrationResult[]> {
    const acquired = await this.driver.acquireAdvisoryLock(
      this.lockId,
      this.lockTimeoutMs,
    );

    if (!acquired) {
      throw new AdvisoryLockError(
        `Failed to acquire migration lock "${this.lockId}" within ${this.lockTimeoutMs}ms. Another migration may be running.`,
      );
    }

    try {
      await this.ensureMigrationTable();
      const executed = await this.getExecutedMigrations();
      const pending = this.migrations.filter((m) => !executed.includes(m.name));

      const ctx = this.createContext();
      await this.hooks.beforeAll?.(ctx);

      const results: MigrationResult[] = [];

      for (const migration of pending) {
        const result = await this.runUp(migration);
        results.push(result);
        if (!result.success) {
          break;
        }
      }

      await this.hooks.afterAll?.(ctx, results);

      return results;
    } finally {
      await this.driver.releaseAdvisoryLock(this.lockId);
    }
  }

  /**
   * 단일 마이그레이션을 적용합니다.
   */
  async runUp(migration: Migration): Promise<MigrationResult> {
    const context = this.createContext();

    try {
      this.logger.info(`Running migration: ${migration.name}`);
      await this.hooks.beforeEach?.(migration, context);

      const startTime = Date.now();
      await migration.up(context);
      const durationMs = Date.now() - startTime;

      try {
        await this.recordMigration(migration.name);
      } catch (trackError: unknown) {
        // #161: Schema changed but tracking record failed — critical desync
        const msg =
          trackError instanceof Error ? trackError.message : String(trackError);
        this.logger.error(
          `CRITICAL: Migration "${migration.name}" applied but tracking record failed: ${msg}. ` +
            `The __migrations table may be out of sync with the actual schema.`,
        );
        return {
          name: migration.name,
          direction: "up",
          success: false,
          error: `Tracking failed: ${msg}`,
        };
      }

      await this.hooks.afterEach?.(migration, context, durationMs);
      this.logger.info(`Migration completed: ${migration.name} (${durationMs}ms)`);
      return { name: migration.name, direction: "up", success: true };
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error(`Migration failed: ${migration.name} - ${error}`);
      await this.hooks.onError?.(migration, e instanceof Error ? e : new Error(error), context);
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
      await this.hooks.beforeEach?.(migration, context);

      const startTime = Date.now();
      await migration.down(context);
      const durationMs = Date.now() - startTime;

      try {
        await this.removeMigrationRecord(migration.name);
      } catch (trackError: unknown) {
        // #161: Schema reverted but tracking record removal failed — critical desync
        const msg =
          trackError instanceof Error ? trackError.message : String(trackError);
        this.logger.error(
          `CRITICAL: Migration "${migration.name}" reverted but tracking record removal failed: ${msg}. ` +
            `The __migrations table may be out of sync.`,
        );
        return {
          name: migration.name,
          direction: "down",
          success: false,
          error: `Tracking failed: ${msg}`,
        };
      }

      await this.hooks.afterEach?.(migration, context, durationMs);
      this.logger.info(`Migration reverted: ${migration.name} (${durationMs}ms)`);
      return { name: migration.name, direction: "down", success: true };
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `Migration revert failed: ${migration.name} - ${error}`,
      );
      await this.hooks.onError?.(migration, e instanceof Error ? e : new Error(error), context);
      return { name: migration.name, direction: "down", success: false, error };
    }
  }

  /**
   * 가장 최근에 실행된 마이그레이션을 되돌립니다.
   * Advisory lock을 사용하여 동시 실행을 방지합니다.
   */
  async revertLast(): Promise<MigrationResult | null> {
    const acquired = await this.driver.acquireAdvisoryLock(
      this.lockId,
      this.lockTimeoutMs,
    );
    if (!acquired) {
      throw new AdvisoryLockError(
        `Failed to acquire migration lock "${this.lockId}" within ${this.lockTimeoutMs}ms. Another migration may be running.`,
      );
    }

    try {
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
    } finally {
      await this.driver.releaseAdvisoryLock(this.lockId);
    }
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
   * Advisory lock을 사용하여 동시 실행을 방지합니다.
   *
   * @param n 되돌릴 마이그레이션 수. 기본값 1.
   */
  async rollback(n: number = 1): Promise<MigrationResult[]> {
    const acquired = await this.driver.acquireAdvisoryLock(
      this.lockId,
      this.lockTimeoutMs,
    );
    if (!acquired) {
      throw new AdvisoryLockError(
        `Failed to acquire migration lock "${this.lockId}" within ${this.lockTimeoutMs}ms. Another migration may be running.`,
      );
    }

    try {
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
    } finally {
      await this.driver.releaseAdvisoryLock(this.lockId);
    }
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
    const w = (n: string) => this.wrapIdentifier(n);
    await this.queryRunner.query(
      `INSERT INTO ${w(this.tableName)} (${w("name")}) VALUES ('${name.replace(/'/g, "''")}')`,
    );
  }

  private async removeMigrationRecord(name: string): Promise<void> {
    const w = (n: string) => this.wrapIdentifier(n);
    await this.queryRunner.query(
      `DELETE FROM ${w(this.tableName)} WHERE ${w("name")} = '${name.replace(/'/g, "''")}'`,
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
