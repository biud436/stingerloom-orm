/* eslint-disable @typescript-eslint/no-explicit-any */
import { ISqlDriver } from "../dialects/SqlDriver";
import { Logger } from "../utils";
import { Migration, MigrationContext } from "./Migration";
import { AdvisoryLockError } from "../errors/AdvisoryLockError";

/**
 * Result of a migration execution.
 */
export interface MigrationResult {
  name: string;
  direction: "up" | "down";
  success: boolean;
  error?: string;
}

/**
 * Row shape recorded in the __migrations table.
 */
export interface MigrationRecord {
  name: string;
  executed_at: string;
}

/**
 * Query execution interface injected into MigrationRunner.
 * Abstracted so that tests do not depend on TransactionSessionManager.
 */
export interface MigrationQueryRunner {
  query: (sql: string) => Promise<any>;
}

/**
 * Migration runner.
 * Executes pending migrations in order and records them in the __migrations table.
 * Supports the MySQL, PostgreSQL, and SQLite drivers.
 *
 * This class is an abstract base; use it via dialect-specific subclasses
 * (MySqlMigrationRunner, PostgresMigrationRunner, SqliteMigrationRunner).
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
   * Wraps an identifier with the dialect-specific quoting character.
   * MySQL: backtick (`); PostgreSQL/SQLite: double-quote (").
   */
  protected abstract wrapIdentifier(name: string): string;

  /**
   * Returns the auto-increment primary key column definition.
   * MySQL: "INT AUTO_INCREMENT PRIMARY KEY"
   * PostgreSQL: "SERIAL PRIMARY KEY"
   * SQLite: "INTEGER PRIMARY KEY AUTOINCREMENT"
   */
  protected abstract autoIncrementPkDefinition(): string;

  /**
   * Creates the __migrations tracking table.
   * Does nothing if it already exists.
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
   * Returns the names of migrations that have already been executed.
   */
  async getExecutedMigrations(): Promise<string[]> {
    const w = (n: string) => this.wrapIdentifier(n);

    const result = await this.queryRunner.query(
      `SELECT ${w("name")} FROM ${w(this.tableName)} ORDER BY ${w("id")} ASC`,
    );

    // Normalize the driver-specific result shape
    const rows = this.normalizeRows(result);
    return rows.map((row: any) => row.name);
  }

  /**
   * Executes pending migrations in order.
   * Uses an advisory lock to prevent concurrent execution.
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
   * Applies a single migration.
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
   * Reverts a single migration.
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
   * Reverts the most recently executed migration.
   * Uses an advisory lock to prevent concurrent execution.
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
   * Executes pending migrations in name order.
   * Alias for runAll(); accepts an optional external migration list.
   *
   * @param migrations migrations to run. If omitted, uses the list passed to the constructor.
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
   * Reverts the most recent n migrations.
   * Uses an advisory lock to prevent concurrent execution.
   *
   * @param n number of migrations to revert. Defaults to 1.
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
   * Returns the migration status.
   * Reports executed and pending migration lists separately.
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
   * Returns the list of pending migrations.
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
   * Normalizes driver-specific query results into an array of rows.
   * MySQL: { results: [...], fields: [...] }
   * PostgreSQL: { rows: [...] } or a direct array
   */
  private normalizeRows(result: any): any[] {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (result.results && Array.isArray(result.results)) return result.results;
    if (result.rows && Array.isArray(result.rows)) return result.rows;
    return [];
  }
}
