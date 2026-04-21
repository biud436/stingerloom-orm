/* eslint-disable @typescript-eslint/no-explicit-any */
import { DatabaseClient } from "../DatabaseClient";
import { DatabaseClientOptions } from "../core/DatabaseClientOptions";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { MySqlDriver } from "../dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../dialects/sqlite/SqliteDriver";
import { ISqlDriver } from "../dialects/SqlDriver";
import { Logger } from "../utils";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { Migration } from "./Migration";
import { MigrationResult, MigrationRunner } from "./MigrationRunner";
import { MySqlMigrationRunner } from "./MySqlMigrationRunner";
import { PostgresMigrationRunner } from "./PostgresMigrationRunner";
import { SqliteMigrationRunner } from "./SqliteMigrationRunner";
import { SchemaDiff } from "../core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../core/generators/SchemaDiffMigrationGenerator";
import { SchemaDialect } from "../core/generators/SchemaGenerator";

export type MigrationCommand = "migrate:run" | "migrate:rollback" | "migrate:status" | "migrate:generate";

/**
 * Migration CLI entry point.
 * Accepts DatabaseClientOptions, connects, and runs the MigrationRunner.
 */
export interface MigrationGenerateOptions {
  /** Directory to output generated migration files. Default: "./migrations" */
  outputDir?: string;
  /** Optional migration name suffix for the generated file. */
  name?: string;
}

export class MigrationCli {
  private readonly logger = new Logger(MigrationCli.name);
  private runner?: MigrationRunner;
  private driver?: ISqlDriver;
  private generateOptions: MigrationGenerateOptions = {};

  constructor(
    private readonly migrations: Migration[],
    private readonly options: DatabaseClientOptions,
  ) {}

  /**
   * Sets options for migrate:generate command.
   */
  setGenerateOptions(opts: MigrationGenerateOptions): this {
    this.generateOptions = opts;
    return this;
  }

  /**
   * Connects to the database and initializes the MigrationRunner.
   */
  async connect(): Promise<void> {
    const client = DatabaseClient.getInstance();
    const connector = await client.connect(this.options);

    switch (client.type as IDatabaseType) {
      case "mariadb":
      case "mysql":
        this.driver = new MySqlDriver(connector, client.type!);
        break;
      case "postgres":
        this.driver = new PostgresDriver(
          connector,
          client.type!,
          this.options.schema,
        );
        break;
      case "sqlite":
        this.driver = new SqliteDriver(connector);
        break;
      default:
        throw new OrmError(
          OrmErrorCode.UNSUPPORTED_DATABASE,
          `Unsupported database type: "${this.options.type}". Supported types: mysql, mariadb, postgres, sqlite.`,
        );
    }

    const queryRunner = { query: (sql: string) => connector.query(sql) };

    switch (client.type as IDatabaseType) {
      case "mariadb":
      case "mysql":
        this.runner = new MySqlMigrationRunner(
          this.migrations,
          this.driver,
          queryRunner,
        );
        break;
      case "postgres":
        this.runner = new PostgresMigrationRunner(
          this.migrations,
          this.driver,
          queryRunner,
        );
        break;
      case "sqlite":
        this.runner = new SqliteMigrationRunner(
          this.migrations,
          this.driver,
          queryRunner,
        );
        break;
      default:
        // Should not reach here — driver switch above already throws
        throw new OrmError(
          OrmErrorCode.UNSUPPORTED_DATABASE,
          `Unsupported database type for migration runner: "${this.options.type}".`,
        );
    }
  }

  /**
   * Closes the database connection.
   */
  async close(): Promise<void> {
    await DatabaseClient.getInstance().close();
  }

  /**
   * Executes a CLI command.
   */
  async execute(command: MigrationCommand): Promise<MigrationResult[] | { executed: string[]; pending: string[] } | { filePath: string; sql: { up: string[]; down: string[] } }> {
    if (!this.runner) {
      throw new OrmError(OrmErrorCode.NOT_CONNECTED, "Not connected. Call connect() before execute().");
    }

    switch (command) {
      case "migrate:run":
        return this.migrateRun();
      case "migrate:rollback":
        return this.migrateRollback();
      case "migrate:status":
        return this.migrateStatus();
      case "migrate:generate":
        return this.migrateGenerate();
      default:
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          `Unknown command: ${command}. Valid commands: migrate:run, migrate:rollback, migrate:status, migrate:generate.`,
        );
    }
  }

  /**
   * migrate:run — run all pending migrations.
   */
  async migrateRun(): Promise<MigrationResult[]> {
    if (!this.runner) {
      throw new OrmError(OrmErrorCode.NOT_CONNECTED, "Not connected. Call connect() before migrateRun().");
    }

    this.logger.info("Running pending migrations...");
    const results = await this.runner.run();

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (results.length === 0) {
      this.logger.info("No pending migrations.");
    } else {
      this.logger.info(
        `Migration complete: ${succeeded} succeeded, ${failed} failed.`,
      );
    }

    return results;
  }

  /**
   * migrate:rollback — roll back the last migration.
   */
  async migrateRollback(): Promise<MigrationResult[]> {
    if (!this.runner) {
      throw new OrmError(OrmErrorCode.NOT_CONNECTED, "Not connected. Call connect() before migrateRollback().");
    }

    this.logger.info("Rolling back last migration...");
    const results = await this.runner.rollback(1);

    if (results.length === 0) {
      this.logger.info("No migrations to rollback.");
    } else {
      const result = results[0];
      if (result.success) {
        this.logger.info(`Rolled back: ${result.name}`);
      } else {
        this.logger.error(`Rollback failed: ${result.name} - ${result.error}`);
      }
    }

    return results;
  }

   /**
   * migrate:status — print executed and pending migration lists.
   */
  async migrateStatus(): Promise<{ executed: string[]; pending: string[] }> {
    if (!this.runner) {
      throw new OrmError(OrmErrorCode.NOT_CONNECTED, "Not connected. Call connect() before migrateStatus().");
    }

    const status = await this.runner.status();

    this.logger.info(`Executed migrations (${status.executed.length}):`);
    for (const name of status.executed) {
      this.logger.info(`  [done] ${name}`);
    }

    this.logger.info(`Pending migrations (${status.pending.length}):`);
    for (const name of status.pending) {
      this.logger.info(`  [pending] ${name}`);
    }

    return status;
  }

  /**
   * migrate:generate — Compares entity definitions against the current DB schema
   * and auto-generates a migration file with the detected changes.
   */
  async migrateGenerate(): Promise<{ filePath: string; sql: { up: string[]; down: string[] } }> {
    if (!this.driver) {
      throw new OrmError(OrmErrorCode.NOT_CONNECTED, "Not connected. Call connect() before migrateGenerate().");
    }

    const entities = (this.options.entities ?? []) as Array<new (...args: any[]) => any>;
    const dbType = this.options.type;
    const dialect: SchemaDialect =
      dbType === "mysql" || dbType === "mariadb" ? "mysql"
        : dbType === "sqlite" ? "sqlite"
        : "postgres";

    this.logger.info("Comparing entity definitions against database schema...");

    const queryRunner = {
      query: async (sqlStr: string | import("sql-template-tag").Sql) => {
        const client = DatabaseClient.getInstance();
        const conn = await client.getConnection();
        const result = await conn.query(sqlStr as any);
        return (result as any)?.results ?? result;
      },
    };

    const schemaDiff = new SchemaDiff();
    const diff = await schemaDiff.diff(entities, queryRunner, dialect);

    const hasChanges =
      diff.addTables.length > 0 ||
      diff.dropTables.length > 0 ||
      diff.addColumns.length > 0 ||
      diff.dropColumns.length > 0 ||
      diff.alterColumns.length > 0;

    if (!hasChanges) {
      this.logger.info("No schema changes detected. No migration generated.");
      return { filePath: "", sql: { up: [], down: [] } };
    }

    const generator = new SchemaDiffMigrationGenerator();
    const content = generator.generate(diff, dialect);
    const sqlPreview = generator.dryRun(diff, dialect);

    const outputDir = this.generateOptions.outputDir ?? "./migrations";
    const filePath = await generator.save(content, outputDir, this.generateOptions.name);

    this.logger.info(`Migration generated: ${filePath}`);
    this.logger.info(`  Up statements: ${sqlPreview.up.length}`);
    this.logger.info(`  Down statements: ${sqlPreview.down.length}`);

    return { filePath, sql: sqlPreview };
  }
}
