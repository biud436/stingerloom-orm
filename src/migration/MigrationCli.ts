/* eslint-disable @typescript-eslint/no-explicit-any */
import { DatabaseClient } from "../DatabaseClient";
import { DatabaseClientOptions } from "../core/DatabaseClientOptions";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { MySqlDriver } from "../dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../dialects/sqlite/SqliteDriver";
import { ISqlDriver } from "../dialects/SqlDriver";
import { Logger } from "../utils";
import { Migration } from "./Migration";
import { MigrationResult, MigrationRunner } from "./MigrationRunner";

export type MigrationCommand = "migrate:run" | "migrate:rollback" | "migrate:status";

/**
 * 마이그레이션 CLI 진입점.
 * DatabaseClientOptions를 받아 연결 후 MigrationRunner를 실행합니다.
 */
export class MigrationCli {
  private readonly logger = new Logger(MigrationCli.name);
  private runner?: MigrationRunner;
  private driver?: ISqlDriver;

  constructor(
    private readonly migrations: Migration[],
    private readonly options: DatabaseClientOptions,
  ) {}

  /**
   * DB에 연결하고 MigrationRunner를 초기화합니다.
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
        throw new Error("Unsupported database type.");
    }

    this.runner = new MigrationRunner(this.migrations, this.driver, {
      query: (sql: string) => connector.query(sql),
    });
  }

  /**
   * DB 연결을 종료합니다.
   */
  async close(): Promise<void> {
    await DatabaseClient.getInstance().close();
  }

  /**
   * CLI 명령어를 실행합니다.
   */
  async execute(command: MigrationCommand): Promise<MigrationResult[] | { executed: string[]; pending: string[] }> {
    if (!this.runner) {
      throw new Error("Not connected. Call connect() before execute().");
    }

    switch (command) {
      case "migrate:run":
        return this.migrateRun();
      case "migrate:rollback":
        return this.migrateRollback();
      case "migrate:status":
        return this.migrateStatus();
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  /**
   * migrate:run — 모든 pending 마이그레이션 실행
   */
  async migrateRun(): Promise<MigrationResult[]> {
    if (!this.runner) {
      throw new Error("Not connected. Call connect() before migrateRun().");
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
   * migrate:rollback — 마지막 마이그레이션 rollback
   */
  async migrateRollback(): Promise<MigrationResult[]> {
    if (!this.runner) {
      throw new Error("Not connected. Call connect() before migrateRollback().");
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
   * migrate:status — 실행됨/미실행 목록 출력
   */
  async migrateStatus(): Promise<{ executed: string[]; pending: string[] }> {
    if (!this.runner) {
      throw new Error("Not connected. Call connect() before migrateStatus().");
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
}
