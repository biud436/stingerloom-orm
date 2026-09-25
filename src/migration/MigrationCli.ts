/* eslint-disable @typescript-eslint/no-explicit-any */
import { DatabaseClient } from "../DatabaseClient";
import { DatabaseClientOptions } from "../core/DatabaseClientOptions";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { MySqlDriver } from "../dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../dialects/sqlite/SqliteDriver";
import { ISqlDriver } from "../dialects/SqlDriver";
import { Logger, resolveEntityGlobs } from "../utils";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { Migration } from "./Migration";
import { MigrationResult, MigrationRunner } from "./MigrationRunner";
import { MySqlMigrationRunner } from "./MySqlMigrationRunner";
import { PostgresMigrationRunner } from "./PostgresMigrationRunner";
import { SqliteMigrationRunner } from "./SqliteMigrationRunner";
import { SchemaDiff, SchemaDiffResult } from "../core/generators/SchemaDiff";
import { describeGenerateGaps } from "../core/generators/uncomparedSchemaChanges";
import { SchemaDiffMigrationGenerator } from "../core/generators/SchemaDiffMigrationGenerator";
import { SchemaDialect } from "../core/generators/SchemaGenerator";
import { createColumnDefinitionBuilder } from "../dialects/ColumnDefinitionBuilder";
import { EntityManager } from "../core/EntityManager";

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
    } else if (failed > 0) {
      // A failed migration is reported in the result array, not thrown — log it
      // at error level so it is visible in a CI log that only greps for errors.
      this.logger.error(
        `Migration incomplete: ${succeeded} succeeded, ${failed} failed.`,
      );
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

    // `entities` may hold glob pattern strings — the same shape the runtime
    // EntityManager accepts. They used to be cast straight to constructors, so
    // the diff walked a string as if it were an entity class and the command
    // died with an empty "Migration failed: " message.
    const configured = (this.options.entities ?? []) as (Function | string)[];
    if (configured.length === 0) {
      this.logger.warn(
        "No entities configured: migrate:generate diffs the `entities` list against the database, so an empty list can only report \"no changes\".",
      );
    }
    const entities = (await resolveEntityGlobs(
      configured,
    )) as Array<new (...args: any[]) => any>;
    // Resolve table/column names through the same naming strategy the runtime
    // EntityManager applies. Without this, an app booted with
    // SnakeNamingStrategy would have snake_case columns in the DB while the
    // diff sees camelCase property names on the entities, generating spurious
    // DROP/ADD migrations.
    EntityManager.applyNamingStrategyToEntities(entities, this.options.namingStrategy);
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

    // Declared types (and the RENAME form MySQL < 8 needs) come from the
    // connected server's capabilities, exactly like the runtime synchronize
    // path — a migration generated against MariaDB 10.7 must not propose the
    // CHAR(36) spelling MySQL would get.
    const capabilities = this.driver?.getCapabilities?.();
    const columnBuilder = createColumnDefinitionBuilder(
      dialect,
      this.options.schema,
      capabilities,
    );

    const schemaDiff = new SchemaDiff();
    const diff = await schemaDiff.diff(entities, queryRunner, dialect, undefined, {
      columnBuilder,
    });

    // Tables the diff did not create are compared column by column only.
    const created = new Set<unknown>(
      Object.values(diff.addTableEntityMap ?? {}),
    );
    const existing = entities.filter((entity) => !created.has(entity));
    const reportGaps = () => {
      if (existing.length > 0) {
        this.logger.info(describeGenerateGaps(existing, dialect));
      }
    };

    if (!this.hasChanges(diff)) {
      this.logger.info("No schema changes detected. No migration generated.");
      reportGaps();
      return { filePath: "", sql: { up: [], down: [] } };
    }

    const generator = new SchemaDiffMigrationGenerator(
      capabilities,
      this.driver?.getVersion?.()?.raw,
    );
    const content = generator.generate(diff, dialect);
    const sqlPreview = generator.dryRun(diff, dialect);

    const outputDir = this.generateOptions.outputDir ?? "./migrations";
    const filePath = await generator.save(content, outputDir, this.generateOptions.name);

    this.logger.info(`Migration generated: ${filePath}`);
    this.logger.info(`  Up statements: ${sqlPreview.up.length}`);
    this.logger.info(`  Down statements: ${sqlPreview.down.length}`);
    reportGaps();

    return { filePath, sql: sqlPreview };
  }

  /**
   * Whether the diff carries anything a migration would do. Renames, enum
   * values and generated columns live outside the add/drop/alter lists, and a
   * diff holding only one of them used to be reported as "no changes" —
   * while synchronize applied it.
   *
   * An enum value present only in the database is not a change: PostgreSQL
   * cannot drop it, so a migration could only repeat the warning comment on
   * every run.
   */
  private hasChanges(diff: SchemaDiffResult): boolean {
    return (
      diff.addTables.length > 0 ||
      diff.dropTables.length > 0 ||
      diff.addColumns.length > 0 ||
      diff.dropColumns.length > 0 ||
      diff.alterColumns.length > 0 ||
      (diff.renamedColumns?.length ?? 0) > 0 ||
      (diff.addComputedColumns?.length ?? 0) > 0 ||
      (diff.enumChanges ?? []).some(
        (change) => change.isNew || change.addValues.length > 0,
      )
    );
  }
}
