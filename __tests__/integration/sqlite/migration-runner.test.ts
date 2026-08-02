/**
 * SQLite In-Memory: MigrationRunner roundtrip (issue #404).
 *
 * Backfills __tests__/unit/migration.test.ts, where the "recorded in
 * __migrations → skipped/reverted next run" contract was proven by a
 * self-consistent mock: the SELECT was stubbed with exactly the names the
 * test expected, so the record/skip/revert cycle never touched a real
 * tracking table. Here every claim is driven by the real __migrations
 * rows: what runAll() records, what a second runAll() skips because of
 * those rows, and what runDown()/revertLast()/rollback() remove.
 */

import "reflect-metadata";
import { SqliteConnector } from "../../../src/dialects/sqlite/SqliteConnector";
import { SqliteDriver } from "../../../src/dialects/sqlite/SqliteDriver";
import { DatabaseClientOptions } from "../../../src/core/DatabaseClientOptions";
import {
  Migration,
  MigrationContext,
  MigrationQueryRunner,
  SqliteMigrationRunner,
} from "../../../src/migration";

describe("[Integration] SQLite: MigrationRunner roundtrip", () => {
  let connector: SqliteConnector;
  let driver: SqliteDriver;
  let queryRunner: MigrationQueryRunner;

  beforeEach(async () => {
    // Fresh in-memory DB per test — each roundtrip starts from zero state.
    connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      database: ":memory:",
      logging: false,
    } as DatabaseClientOptions);
    driver = new SqliteDriver(connector);
    queryRunner = { query: (sql: string) => connector.query(sql) };
  });

  afterEach(async () => {
    await connector.close();
  });

  async function migrationRecords(): Promise<string[]> {
    const rows = await connector.query(
      'SELECT "name" FROM "__migrations" ORDER BY "id" ASC',
    );
    return (rows as any[]).map((r) => r.name);
  }

  async function tableExists(name: string): Promise<boolean> {
    const rows = await connector.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`,
    );
    return (rows as any[]).length > 0;
  }

  class CreateUsersTable extends Migration {
    static upRuns = 0;
    async up(ctx: MigrationContext): Promise<void> {
      CreateUsersTable.upRuns++;
      await ctx.query(
        'CREATE TABLE "mig_users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)',
      );
    }
    async down(ctx: MigrationContext): Promise<void> {
      await ctx.query('DROP TABLE "mig_users"');
    }
  }

  class AddEmailToUsers extends Migration {
    static upRuns = 0;
    async up(ctx: MigrationContext): Promise<void> {
      AddEmailToUsers.upRuns++;
      await ctx.query('ALTER TABLE "mig_users" ADD COLUMN "email" TEXT');
    }
    async down(ctx: MigrationContext): Promise<void> {
      // SQLite cannot DROP COLUMN on old versions; recreate is out of scope
      // for this fixture, so down is a tracked no-op.
    }
  }

  class CreatePostsTable extends Migration {
    async up(ctx: MigrationContext): Promise<void> {
      await ctx.query(
        'CREATE TABLE "mig_posts" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT)',
      );
    }
    async down(ctx: MigrationContext): Promise<void> {
      await ctx.query('DROP TABLE "mig_posts"');
    }
  }

  class FailingMigration extends Migration {
    async up(): Promise<void> {
      throw new Error("Migration intentionally failed");
    }
    async down(): Promise<void> {}
  }

  beforeEach(() => {
    CreateUsersTable.upRuns = 0;
    AddEmailToUsers.upRuns = 0;
  });

  it("runAll — 실 스키마를 변경하고 __migrations에 순서대로 기록해야 한다", async () => {
    const runner = new SqliteMigrationRunner(
      [new CreateUsersTable(), new AddEmailToUsers()],
      driver,
      queryRunner,
    );

    const results = await runner.runAll();

    expect(results.map((r) => [r.name, r.success])).toEqual([
      ["CreateUsersTable", true],
      ["AddEmailToUsers", true],
    ]);
    // The schema really changed: table exists and the added column accepts data.
    await connector.query(
      `INSERT INTO "mig_users" ("name", "email") VALUES ('a', 'a@b.c')`,
    );
    // The tracking table records both, in execution order.
    expect(await migrationRecords()).toEqual([
      "CreateUsersTable",
      "AddEmailToUsers",
    ]);
  });

  it("두 번째 runAll — 실제 __migrations 행 때문에 이미 실행된 것을 건너뛰어야 한다", async () => {
    const make = () =>
      new SqliteMigrationRunner(
        [new CreateUsersTable(), new AddEmailToUsers()],
        driver,
        queryRunner,
      );

    await make().runAll();
    const second = await make().runAll();

    // Nothing pending: no result rows, and neither up() ran twice
    // (a re-run would also crash on CREATE TABLE, but the counters prove
    // the skip happened at the tracking layer, not by accident).
    expect(second).toEqual([]);
    expect(CreateUsersTable.upRuns).toBe(1);
    expect(AddEmailToUsers.upRuns).toBe(1);
  });

  it("부분 실행 후 추가된 마이그레이션만 실행되어야 한다", async () => {
    await new SqliteMigrationRunner(
      [new CreateUsersTable()],
      driver,
      queryRunner,
    ).runAll();

    const results = await new SqliteMigrationRunner(
      [new CreateUsersTable(), new CreatePostsTable()],
      driver,
      queryRunner,
    ).runAll();

    expect(results.map((r) => r.name)).toEqual(["CreatePostsTable"]);
    expect(await migrationRecords()).toEqual([
      "CreateUsersTable",
      "CreatePostsTable",
    ]);
    expect(await tableExists("mig_posts")).toBe(true);
  });

  it("실패한 마이그레이션은 기록되지 않고 이후 실행이 중단되어야 한다", async () => {
    const runner = new SqliteMigrationRunner(
      [new CreateUsersTable(), new FailingMigration(), new CreatePostsTable()],
      driver,
      queryRunner,
    );

    const results = await runner.runAll();

    expect(results.map((r) => [r.name, r.success])).toEqual([
      ["CreateUsersTable", true],
      ["FailingMigration", false],
    ]);
    // Only the successful one is recorded; the failed and the halted are not.
    expect(await migrationRecords()).toEqual(["CreateUsersTable"]);
    expect(await tableExists("mig_posts")).toBe(false);

    // A subsequent run retries the failed one (still pending in the table).
    const retry = await runner.runAll();
    expect(retry.map((r) => r.name)).toEqual(["FailingMigration"]);
  });

  it("runDown — 스키마를 되돌리고 __migrations 기록을 삭제해야 한다", async () => {
    const create = new CreateUsersTable();
    const runner = new SqliteMigrationRunner([create], driver, queryRunner);
    await runner.runAll();
    expect(await tableExists("mig_users")).toBe(true);

    const result = await runner.runDown(create);

    expect(result).toMatchObject({ direction: "down", success: true });
    expect(await tableExists("mig_users")).toBe(false);
    expect(await migrationRecords()).toEqual([]);
  });

  it("revertLast — 실제 테이블에서 가장 최근 기록을 골라 되돌려야 한다", async () => {
    const runner = new SqliteMigrationRunner(
      [new CreateUsersTable(), new CreatePostsTable()],
      driver,
      queryRunner,
    );
    await runner.runAll();

    const result = await runner.revertLast();

    expect(result).toMatchObject({
      name: "CreatePostsTable",
      direction: "down",
      success: true,
    });
    expect(await tableExists("mig_posts")).toBe(false);
    expect(await migrationRecords()).toEqual(["CreateUsersTable"]);

    // Reverted migration is pending again.
    const status = await runner.status();
    expect(status.executed).toEqual(["CreateUsersTable"]);
    expect(status.pending).toEqual(["CreatePostsTable"]);
  });

  it("rollback(n) — 최근 n개를 역순으로 되돌려야 한다", async () => {
    const runner = new SqliteMigrationRunner(
      [new CreateUsersTable(), new AddEmailToUsers(), new CreatePostsTable()],
      driver,
      queryRunner,
    );
    await runner.runAll();

    const results = await runner.rollback(2);

    expect(results.map((r) => [r.name, r.success])).toEqual([
      ["CreatePostsTable", true],
      ["AddEmailToUsers", true],
    ]);
    expect(await migrationRecords()).toEqual(["CreateUsersTable"]);
    expect(await tableExists("mig_posts")).toBe(false);
    expect(await tableExists("mig_users")).toBe(true);
  });

  it("status — 실제 기록 기준으로 executed/pending을 보고해야 한다", async () => {
    const runner = new SqliteMigrationRunner(
      [new CreateUsersTable(), new AddEmailToUsers()],
      driver,
      queryRunner,
    );

    const before = await runner.status();
    expect(before.executed).toEqual([]);
    expect(before.pending).toEqual(["CreateUsersTable", "AddEmailToUsers"]);

    await runner.runAll();

    const after = await runner.status();
    expect(after.executed).toEqual(["CreateUsersTable", "AddEmailToUsers"]);
    expect(after.pending).toEqual([]);
  });
});
