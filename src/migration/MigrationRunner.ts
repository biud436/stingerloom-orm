/* eslint-disable @typescript-eslint/no-explicit-any */
import { ISqlDriver } from "../dialects/SqlDriver";
import { Logger } from "../utils";
import { Migration, MigrationContext } from "./Migration";
import { AdvisoryLockError } from "../errors/AdvisoryLockError";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { MetadataContext } from "../metadata/MetadataContext";

/**
 * What PostgreSQL and SQLite say when a statement cannot run in a
 * transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`, using an enum value
 * added in the same transaction).
 */
const TRANSACTION_BLOCK_ERROR = /(?:inside|within) a transaction|unsafe use of new value/i;

function withoutFinalPeriod(message: string): string {
  return message.replace(/[.\s]+$/, "");
}

/** A migration that ran but whose tracking row could not be written. */
class TrackingFailure extends Error {
  constructor(readonly trackError: unknown) {
    super(trackError instanceof Error ? trackError.message : String(trackError));
  }
}

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
 *
 * The runner reads and writes its tracking table through it, and so does a
 * migration that runs outside a transaction. A migration in a transaction
 * runs on a connection of the driver's pool instead (see
 * `Migration.transaction`).
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
    return this.apply(migration, "up");
  }

  /**
   * Reverts a single migration.
   */
  async runDown(migration: Migration): Promise<MigrationResult> {
    return this.apply(migration, "down");
  }

  /**
   * Why a migration that does not set `transaction` runs outside a
   * transaction on this runner's database, or `undefined` when it runs in
   * one.
   */
  protected outsideTransactionByDefault(): string | undefined {
    return undefined;
  }

  /**
   * Why `sql` must not run inside a migration's transaction, or `undefined`
   * when it may.
   */
  protected refuseInTransaction(_sql: string): string | undefined {
    return undefined;
  }

  /**
   * Runs `migration` in `direction` and writes or deletes its tracking row.
   * In a transaction, both commit or roll back together; outside one, each
   * statement commits as it runs.
   */
  private async apply(
    migration: Migration,
    direction: "up" | "down",
  ): Promise<MigrationResult> {
    const context = this.createContext();
    const name = migration.name;
    const up = direction === "up";
    let inTransaction = false;
    // Outside a transaction: the statements that ran, and why there was no
    // transaction. A later failure leaves them applied.
    const applied: string[] = [];
    let outsideReason: string | undefined;

    try {
      this.logger.info(`${up ? "Running" : "Reverting"} migration: ${name}`);
      await this.hooks.beforeEach?.(migration, context);

      const startTime = Date.now();
      outsideReason = this.outsideTransactionReason(migration);
      if (outsideReason === undefined) {
        inTransaction = true;
        await this.applyInTransaction(migration, direction);
      } else {
        const trackingFailed = await this.applyOutsideTransaction(migration, direction, applied);
        if (trackingFailed) return trackingFailed;
      }
      const durationMs = Date.now() - startTime;

      await this.hooks.afterEach?.(migration, context, durationMs);
      this.logger.info(
        `Migration ${up ? "completed" : "reverted"}: ${name} (${durationMs}ms)`,
      );
      return { name, direction, success: true };
    } catch (e: unknown) {
      const cause = e instanceof TrackingFailure ? e.trackError : e;
      const message = cause instanceof Error ? cause.message : String(cause);
      let error = e instanceof TrackingFailure ? `Tracking failed: ${message}` : message;
      if (inTransaction) {
        if (!(cause instanceof OrmError) && TRANSACTION_BLOCK_ERROR.test(message)) {
          error =
            `${withoutFinalPeriod(error)}. The migration ran in a transaction, which this ` +
            "statement cannot run in; set `transaction = false` on it to run its statements one at a time";
        }
      } else if (applied.length > 0) {
        error = withoutFinalPeriod(error) + this.describeApplied(applied, outsideReason ?? "");
      }
      this.logger.error(
        `Migration ${up ? "failed" : "revert failed"}: ${name} - ${error}` +
          (inTransaction ? " (rolled back: none of its changes were kept)" : ""),
      );
      await this.hooks.onError?.(
        migration,
        cause instanceof Error ? cause : new Error(error),
        context,
      );
      return { name, direction, success: false, error };
    }
  }

  /**
   * Why `migration` runs outside a transaction, or `undefined` when it runs
   * in one.
   */
  private outsideTransactionReason(migration: Migration): string | undefined {
    const wanted = migration.transaction;
    if (wanted === false) return "it sets `transaction = false`";
    if (wanted === undefined) {
      const reason = this.outsideTransactionByDefault();
      if (reason !== undefined) return reason;
    }
    if (typeof this.driver.runInTransaction !== "function") {
      if (wanted === true) {
        throw new OrmError(
          OrmErrorCode.UNSUPPORTED_OPERATION,
          `Migration "${migration.name}" sets \`transaction = true\`, but its driver cannot open a transaction.`,
        );
      }
      return "its driver cannot open a transaction";
    }
    return undefined;
  }

  private async applyInTransaction(
    migration: Migration,
    direction: "up" | "down",
  ): Promise<void> {
    // Outside any tenant: on PostgreSQL a transaction begun for a tenant
    // points search_path at the tenant's schema, while the runner reads its
    // tracking table, like any pool statement, in the connection's schema.
    await MetadataContext.run("public", () => this.applyInSession(migration, direction));
  }

  private async applyInSession(
    migration: Migration,
    direction: "up" | "down",
  ): Promise<void> {
    await this.driver.runInTransaction!(async (session) => {
      const context: MigrationContext = {
        driver: session.driver,
        query: async (sql: string) => {
          const refusal = this.refuseInTransaction(sql);
          if (refusal !== undefined) {
            throw new OrmError(OrmErrorCode.UNSUPPORTED_OPERATION, refusal);
          }
          return session.query(sql);
        },
      };
      await (direction === "up" ? migration.up(context) : migration.down(context));
      try {
        await this.track(direction, migration.name, (sql) => session.query(sql));
      } catch (trackError: unknown) {
        throw new TrackingFailure(trackError);
      }
    });
  }

  /**
   * Runs `migration` one statement at a time, recording into `applied` each
   * one that ran. Returns a failed result when the migration ran but its
   * tracking row could not be written or deleted.
   */
  private async applyOutsideTransaction(
    migration: Migration,
    direction: "up" | "down",
    applied: string[],
  ): Promise<MigrationResult | undefined> {
    const context: MigrationContext = {
      driver: this.driver,
      query: async (sql: string) => {
        const result = await this.queryRunner.query(sql);
        applied.push(sql);
        return result;
      },
    };
    await (direction === "up" ? migration.up(context) : migration.down(context));

    try {
      await this.track(direction, migration.name, (sql) => this.queryRunner.query(sql));
      return undefined;
    } catch (trackError: unknown) {
      // #161: the schema changed but the tracking row did not — critical desync
      const msg =
        trackError instanceof Error ? trackError.message : String(trackError);
      this.logger.error(
        direction === "up"
          ? `CRITICAL: Migration "${migration.name}" applied but tracking record failed: ${msg}. ` +
              `The __migrations table may be out of sync with the actual schema.`
          : `CRITICAL: Migration "${migration.name}" reverted but tracking record removal failed: ${msg}. ` +
              `The __migrations table may be out of sync.`,
      );
      return {
        name: migration.name,
        direction,
        success: false,
        error: `Tracking failed: ${msg}`,
      };
    }
  }

  /** The note a failure outside a transaction gets about what stayed applied. */
  private describeApplied(applied: string[], reason: string): string {
    const count = applied.length;
    const list = applied
      .map((sql) => {
        const flat = sql.replace(/\s+/g, " ").trim();
        return `  ${flat.length > 200 ? `${flat.slice(0, 197)}...` : flat}`;
      })
      .join("\n");
    return (
      `. It ran outside a transaction (${reason}), so what it ran before failing stays applied, ` +
      `including ${count === 1 ? "this statement" : `these ${count} statements`} from context.query:\n${list}`
    );
  }

  private track(
    direction: "up" | "down",
    name: string,
    query: (sql: string) => Promise<any>,
  ): Promise<void> {
    return direction === "up"
      ? this.recordMigration(name, query)
      : this.removeMigrationRecord(name, query);
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
      try {
        return await this.runAll();
      } finally {
        (this as any).migrations = originalMigrations;
      }
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

  private async recordMigration(
    name: string,
    query: (sql: string) => Promise<any>,
  ): Promise<void> {
    const w = (n: string) => this.wrapIdentifier(n);
    await query(
      `INSERT INTO ${w(this.tableName)} (${w("name")}) VALUES ('${name.replace(/'/g, "''")}')`,
    );
  }

  private async removeMigrationRecord(
    name: string,
    query: (sql: string) => Promise<any>,
  ): Promise<void> {
    const w = (n: string) => this.wrapIdentifier(n);
    await query(
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
