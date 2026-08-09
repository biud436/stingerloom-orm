/* eslint-disable @typescript-eslint/no-explicit-any */
import { EntityManager } from "../core/EntityManager";
import { Seeder, SeederContext } from "./Seeder";
import { Logger } from "../utils";
import { AdvisoryLockError } from "../errors/AdvisoryLockError";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import type { SchemaDialect } from "../core/generators/SchemaGenerator";
import type { EntityManagerInternals } from "../core/EntityManagerInternals";

/**
 * Narrow view of the `EntityManager` internals this runner reads.
 *
 * `_ctx` is private on the public EntityManager type; the runner narrows
 * through a single sanctioned cast (same pattern as SelectQueryBuilder).
 * Test doubles may omit `_ctx` — call sites fall back to the driver.
 */
interface EntityManagerInternalView {
  readonly _ctx?: EntityManagerInternals;
}

/**
 * Result of a single seeder execution.
 */
export interface SeederResult {
  name: string;
  direction: "run" | "revert";
  success: boolean;
  error?: string;
}

/**
 * Options for the SeederRunner.
 */
export interface SeederRunnerOptions {
  /**
   * Whether to track execution in a __seeds table.
   * When false, seeders are always executed without tracking.
   * Default: true
   */
  trackExecution?: boolean;

  /**
   * Name of the seed tracking table.
   * Default: "__seeds"
   */
  tableName?: string;
}

/**
 * Query runner interface for SeederRunner.
 * Decoupled from EntityManager for testability.
 */
export interface SeederQueryRunner {
  query: (sql: string) => Promise<any>;
}

/**
 * Runs database seeders in order, tracking execution in a __seeds table.
 *
 * Follows the same pattern as MigrationRunner:
 * - Tracking table records which seeders have been executed
 * - runAll() skips already-executed seeders
 * - revertLast() calls the most recent seeder's revert() method
 * - status() shows executed/pending seeders
 */
export class SeederRunner {
  private readonly logger = new Logger(SeederRunner.name);
  private readonly seeders: Seeder[];
  private readonly em: EntityManager;
  private readonly queryRunner: SeederQueryRunner;
  private readonly trackExecution: boolean;
  private readonly tableName: string;

  constructor(
    seeders: Seeder[],
    em: EntityManager,
    queryRunner: SeederQueryRunner,
    options?: SeederRunnerOptions,
  ) {
    this.seeders = seeders;
    this.em = em;
    this.queryRunner = queryRunner;
    this.trackExecution = options?.trackExecution ?? true;
    this.tableName = options?.tableName ?? "__seeds";
  }

  /**
   * Creates the seed tracking table if it does not exist.
   * Uses the EntityManager's driver to determine MySQL vs PostgreSQL/SQLite syntax.
   */
  async ensureSeedTable(): Promise<void> {
    const dialect = this.dialect();
    const table = this.quotedTableName();

    if (dialect === "mysql") {
      await this.queryRunner.query(
        `CREATE TABLE IF NOT EXISTS ${table} (` +
          `\`id\` INT AUTO_INCREMENT PRIMARY KEY, ` +
          `\`name\` VARCHAR(255) NOT NULL UNIQUE, ` +
          `\`executed_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP` +
          `)`,
      );
    } else if (dialect === "sqlite") {
      // SERIAL is not an auto-increment type on SQLite — a non-INTEGER PK is
      // not a rowid alias, so every insert would store id = NULL and the
      // ORDER BY id execution-order tracking would be meaningless.
      await this.queryRunner.query(
        `CREATE TABLE IF NOT EXISTS ${table} (` +
          `"id" INTEGER PRIMARY KEY AUTOINCREMENT, ` +
          `"name" VARCHAR(255) NOT NULL UNIQUE, ` +
          `"executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP` +
          `)`,
      );
    } else {
      await this.queryRunner.query(
        `CREATE TABLE IF NOT EXISTS ${table} (` +
          `"id" SERIAL PRIMARY KEY, ` +
          `"name" VARCHAR(255) NOT NULL UNIQUE, ` +
          `"executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP` +
          `)`,
      );
    }
  }

  /**
   * Returns the list of already-executed seeder names.
   */
  async getExecutedSeeds(): Promise<string[]> {
    const isMySql = this.isMySql();
    const quote = isMySql ? "`" : '"';
    const table = this.quotedTableName();

    const result = await this.queryRunner.query(
      `SELECT ${quote}name${quote} FROM ${table} ORDER BY ${quote}id${quote} ASC`,
    );

    const rows = this.normalizeRows(result);
    return rows.map((row: any) => row.name);
  }

  /**
   * Run all pending seeders in order.
   * If trackExecution is true, only runs seeders not yet recorded.
   * Uses advisory lock via driver (if available) to prevent concurrent execution (#168).
   * Stops on first error.
   */
  async runAll(): Promise<SeederResult[]> {
    if (this.trackExecution) {
      await this.ensureSeedTable();
    }

    // #168: Acquire advisory lock to prevent concurrent tracked seed execution
    const driver = this.em.getDriver();
    const lockId = "stingerloom_seed_lock";
    let lockAcquired = false;
    if (this.trackExecution && driver?.acquireAdvisoryLock) {
      lockAcquired = await driver.acquireAdvisoryLock(lockId, 10000);
      if (!lockAcquired) {
        throw new AdvisoryLockError(
          `Failed to acquire seed lock "${lockId}". Another seeder may be running.`,
        );
      }
    }

    try {
      const executed = this.trackExecution
        ? await this.getExecutedSeeds()
        : [];
      const pending = this.seeders.filter((s) => !executed.includes(s.name));

      const results: SeederResult[] = [];

      for (const seeder of pending) {
        const result = await this.executeSeeder(seeder);
        results.push(result);
        if (!result.success) {
          break;
        }
      }

      return results;
    } finally {
      if (lockAcquired && driver?.releaseAdvisoryLock) {
        await driver.releaseAdvisoryLock(lockId);
      }
    }
  }

  /**
   * Run a single seeder. Creates the tracking table first when tracking is
   * enabled, so a standalone `runOne()` records its execution like `runAll()`.
   */
  async runOne(seeder: Seeder): Promise<SeederResult> {
    if (this.trackExecution) {
      await this.ensureSeedTable();
    }
    return this.executeSeeder(seeder);
  }

  /**
   * Run a seeder assuming the tracking table already exists
   * (`runAll()` ensures it once for the whole batch).
   */
  private async executeSeeder(seeder: Seeder): Promise<SeederResult> {
    const ctx = this.createContext();

    try {
      this.logger.info(`Running seeder: ${seeder.name}`);
      await seeder.run(ctx);
      if (this.trackExecution) {
        try {
          await this.recordSeed(seeder.name);
        } catch (trackError: unknown) {
          // #169: If tracking fails after data mutation, log critical warning
          const msg = trackError instanceof Error ? trackError.message : String(trackError);
          this.logger.error(
            `CRITICAL: Seeder "${seeder.name}" ran successfully but tracking record failed: ${msg}. ` +
            `The __seeds table may be out of sync with actual data state.`,
          );
          return { name: seeder.name, direction: "run", success: false, error: `Tracking failed: ${msg}` };
        }
      }
      this.logger.info(`Seeder completed: ${seeder.name}`);
      return { name: seeder.name, direction: "run", success: true };
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error(`Seeder failed: ${seeder.name} - ${error}`);
      return { name: seeder.name, direction: "run", success: false, error };
    }
  }

  /**
   * Revert the most recently executed seeder.
   * Returns null if no seeders have been executed.
   * Returns a failure result if the seeder is not found or has no revert() method.
   */
  async revertLast(): Promise<SeederResult | null> {
    if (this.trackExecution) {
      await this.ensureSeedTable();
    }

    const executed = this.trackExecution
      ? await this.getExecutedSeeds()
      : [];

    if (executed.length === 0) {
      this.logger.info("No seeders to revert.");
      return null;
    }

    const lastName = executed[executed.length - 1];
    const seeder = this.seeders.find((s) => s.name === lastName);

    if (!seeder) {
      const error = `Seeder "${lastName}" not found in registered seeders.`;
      this.logger.error(error);
      return { name: lastName, direction: "revert", success: false, error };
    }

    if (!seeder.revert) {
      const error = `Seeder "${lastName}" does not implement revert().`;
      this.logger.error(error);
      return { name: lastName, direction: "revert", success: false, error };
    }

    const ctx = this.createContext();

    try {
      this.logger.info(`Reverting seeder: ${seeder.name}`);
      await seeder.revert(ctx);
      if (this.trackExecution) {
        try {
          await this.removeSeedRecord(seeder.name);
        } catch (trackError: unknown) {
          // #169: If tracking removal fails after data revert, log critical warning
          const msg = trackError instanceof Error ? trackError.message : String(trackError);
          this.logger.error(
            `CRITICAL: Seeder "${seeder.name}" reverted but tracking record removal failed: ${msg}. ` +
            `The __seeds table may be out of sync.`,
          );
          return { name: seeder.name, direction: "revert", success: false, error: `Tracking failed: ${msg}` };
        }
      }
      this.logger.info(`Seeder reverted: ${seeder.name}`);
      return { name: seeder.name, direction: "revert", success: true };
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error(`Seeder revert failed: ${seeder.name} - ${error}`);
      return { name: seeder.name, direction: "revert", success: false, error };
    }
  }

  /**
   * Returns the current status: which seeders are executed and which are pending.
   */
  async status(): Promise<{ executed: string[]; pending: string[] }> {
    if (this.trackExecution) {
      await this.ensureSeedTable();
    }

    const executed = this.trackExecution
      ? await this.getExecutedSeeds()
      : [];
    const pending = this.seeders
      .filter((s) => !executed.includes(s.name))
      .map((s) => s.name);

    return { executed, pending };
  }

  private createContext(): SeederContext {
    return { em: this.em };
  }

  /**
   * Check if the driver is MySQL-family.
   * Throws if EntityManager has no driver connected.
   */
  private isMySql(): boolean {
    const driver = this.em.getDriver();
    if (!driver) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "SeederRunner: EntityManager has no driver connected.",
      );
    }
    return driver.isMySqlFamily();
  }

  /**
   * Resolve the connected dialect. Prefers the EntityManager's own dialect
   * resolution; falls back to the driver's MySQL check (postgres DDL) when
   * the internals are unavailable (partial EM doubles in tests).
   */
  private dialect(): SchemaDialect {
    if (this.isMySql()) return "mysql";
    const ctx = (this.em as unknown as EntityManagerInternalView)._ctx;
    if (ctx?.getDialect) return ctx.getDialect();
    return "postgres";
  }

  /**
   * Returns the table name properly escaped and wrapped with the appropriate
   * quote character for the current dialect.
   *
   * MySQL uses backticks: `table` (backtick inside name escaped as ``)
   * PostgreSQL/SQLite use double quotes: "table" (double quote inside name escaped as "")
   */
  private quotedTableName(): string {
    const isMySql = this.isMySql();
    if (isMySql) {
      return "`" + this.tableName.replace(/`/g, "``") + "`";
    }
    return '"' + this.tableName.replace(/"/g, '""') + '"';
  }

  private async recordSeed(name: string): Promise<void> {
    const isMySql = this.isMySql();
    const quote = isMySql ? "`" : '"';
    const table = this.quotedTableName();
    await this.queryRunner.query(
      `INSERT INTO ${table} (${quote}name${quote}) VALUES ('${name.replace(/'/g, "''")}')`,
    );
  }

  private async removeSeedRecord(name: string): Promise<void> {
    const isMySql = this.isMySql();
    const quote = isMySql ? "`" : '"';
    const table = this.quotedTableName();
    await this.queryRunner.query(
      `DELETE FROM ${table} WHERE ${quote}name${quote} = '${name.replace(/'/g, "''")}'`,
    );
  }

  /**
   * Normalize driver-specific query results to a plain array of rows.
   */
  private normalizeRows(result: any): any[] {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (result.results && Array.isArray(result.results)) return result.results;
    if (result.rows && Array.isArray(result.rows)) return result.rows;
    return [];
  }
}
