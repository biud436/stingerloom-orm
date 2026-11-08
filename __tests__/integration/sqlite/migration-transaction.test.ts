/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: a migration and its tracking row commit or roll back
 * together.
 *
 * The runner sent each statement of a migration on its own, so a failure
 * part-way left the earlier statements applied and no tracking row: the
 * migration stayed pending, running it again failed on what it had already
 * done, and rollback had nothing to revert.
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

describe("[Integration] SQLite: migrations run in a transaction", () => {
  let connector: SqliteConnector;
  let driver: SqliteDriver;
  let queryRunner: MigrationQueryRunner;

  beforeEach(async () => {
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

  const runner = (migrations: Migration[]) =>
    new SqliteMigrationRunner(migrations, driver, queryRunner);

  async function recorded(): Promise<string[]> {
    const rows = await connector.query('SELECT "name" FROM "__migrations" ORDER BY "id" ASC');
    return (rows as any[]).map((r) => r.name);
  }

  async function columns(table: string): Promise<string[]> {
    const rows = await connector.query(`PRAGMA table_info("${table}")`);
    return (rows as any[]).map((r) => r.name);
  }

  async function tableExists(name: string): Promise<boolean> {
    const rows = await connector.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`,
    );
    return (rows as any[]).length > 0;
  }

  /** Creates a table, adds a column, then fails while `broken` is set. */
  class TwoStep extends Migration {
    static broken = true;
    get name() {
      return "TwoStep";
    }
    async up(ctx: MigrationContext) {
      await ctx.query('CREATE TABLE "ms_t" ("id" INTEGER PRIMARY KEY, "a" TEXT)');
      await ctx.query('ALTER TABLE "ms_t" ADD COLUMN "b" TEXT');
      if (TwoStep.broken) await ctx.query('ALTER TABLE "ms_t" ADD COLUMN');
    }
    async down(ctx: MigrationContext) {
      await ctx.query('DROP TABLE "ms_t"');
    }
  }

  beforeEach(() => {
    TwoStep.broken = true;
  });

  it("rolls back a migration that fails part-way, so it runs again once fixed", async () => {
    const [failed] = await runner([new TwoStep()]).runAll();

    expect(failed).toMatchObject({ name: "TwoStep", direction: "up", success: false });
    expect(await tableExists("ms_t")).toBe(false);
    expect(await recorded()).toEqual([]);
    expect(await runner([new TwoStep()]).status()).toEqual({ executed: [], pending: ["TwoStep"] });

    TwoStep.broken = false;
    const [applied] = await runner([new TwoStep()]).runAll();

    expect(applied).toEqual({ name: "TwoStep", direction: "up", success: true });
    expect(await columns("ms_t")).toEqual(["id", "a", "b"]);
    expect(await recorded()).toEqual(["TwoStep"]);
  });

  it("rolls back a revert that fails part-way and keeps the migration's row", async () => {
    class TwoTables extends Migration {
      static brokenDown = true;
      get name() {
        return "TwoTables";
      }
      async up(ctx: MigrationContext) {
        await ctx.query('CREATE TABLE "ms_a" ("id" INTEGER PRIMARY KEY)');
        await ctx.query('CREATE TABLE "ms_b" ("id" INTEGER PRIMARY KEY)');
      }
      async down(ctx: MigrationContext) {
        await ctx.query('DROP TABLE "ms_b"');
        if (TwoTables.brokenDown) await ctx.query('DROP TABLE "ms_no_such_table"');
        await ctx.query('DROP TABLE "ms_a"');
      }
    }
    await runner([new TwoTables()]).runAll();

    const failed = await runner([new TwoTables()]).revertLast();

    expect(failed).toMatchObject({ name: "TwoTables", direction: "down", success: false });
    expect(await tableExists("ms_a")).toBe(true);
    expect(await tableExists("ms_b")).toBe(true);
    expect(await recorded()).toEqual(["TwoTables"]);

    TwoTables.brokenDown = false;
    const reverted = await runner([new TwoTables()]).revertLast();

    expect(reverted).toEqual({ name: "TwoTables", direction: "down", success: true });
    expect(await tableExists("ms_a")).toBe(false);
    expect(await tableExists("ms_b")).toBe(false);
    expect(await recorded()).toEqual([]);
  });

  it("rolls back the schema change when the tracking row cannot be written", async () => {
    TwoStep.broken = false;
    const migrationRunner = runner([new TwoStep()]);
    await migrationRunner.ensureMigrationTable();
    await connector.query(`INSERT INTO "__migrations" ("name") VALUES ('TwoStep')`);

    const result = await migrationRunner.runUp(new TwoStep());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Tracking failed: .*UNIQUE/);
    expect(await tableExists("ms_t")).toBe(false);
    expect(await recorded()).toEqual(["TwoStep"]);
  });

  it("returns the rows of a read the way a query outside the transaction does", async () => {
    await connector.query('CREATE TABLE "ms_src" ("id" INTEGER PRIMARY KEY, "v" TEXT)');
    await connector.query(`INSERT INTO "ms_src" ("id", "v") VALUES (1, 'x'), (2, 'y')`);
    let read: unknown;
    class CopyRows extends Migration {
      async up(ctx: MigrationContext) {
        read = await ctx.query('SELECT "id", "v" FROM "ms_src" ORDER BY "id"');
        await ctx.query('CREATE TABLE "ms_dst" AS SELECT * FROM "ms_src"');
      }
      async down() {}
    }

    const [result] = await runner([new CopyRows()]).runAll();

    expect(result.success).toBe(true);
    expect(read).toEqual(await queryRunner.query('SELECT "id", "v" FROM "ms_src" ORDER BY "id"'));
    expect(read).toEqual([
      { id: 1, v: "x" },
      { id: 2, v: "y" },
    ]);
    expect(await connector.query('SELECT COUNT(*) AS n FROM "ms_dst"')).toEqual([{ n: 2 }]);
  });

  it("runs context.driver's statements in the migration's transaction", async () => {
    class WithDriver extends Migration {
      static broken = true;
      async up(ctx: MigrationContext) {
        await ctx.query('CREATE TABLE "ms_d" ("id" INTEGER PRIMARY KEY, "v" TEXT)');
        await ctx.driver.addIndex("ms_d", "v", "ms_d_v_idx");
        expect(await ctx.driver.hasIndex("ms_d", "ms_d_v_idx")).not.toEqual([]);
        if (WithDriver.broken) await ctx.query("SELECT * FROM ms_no_such_table");
      }
      async down() {}
    }

    expect((await runner([new WithDriver()]).runAll())[0].success).toBe(false);
    expect(await tableExists("ms_d")).toBe(false);
    expect(
      await connector.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ms_d_v_idx'`),
    ).toEqual([]);

    WithDriver.broken = false;
    expect((await runner([new WithDriver()]).runAll())[0].success).toBe(true);
    expect(
      await connector.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ms_d_v_idx'`),
    ).toEqual([{ name: "ms_d_v_idx" }]);
  });

  it("holds statements from outside back until the migration commits", async () => {
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    class Slow extends Migration {
      async up(ctx: MigrationContext) {
        await ctx.query('CREATE TABLE "ms_slow" ("id" INTEGER PRIMARY KEY)');
        entered();
        await finished;
      }
      async down() {}
    }

    const run = runner([new Slow()]).runAll();
    await inside;
    let readSettled = false;
    const read = connector
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ms_slow'`)
      .finally(() => {
        readSettled = true;
      });
    await new Promise((resolve) => setImmediate(resolve));
    expect(readSettled).toBe(false);

    finish();
    expect((await run)[0].success).toBe(true);
    expect(await read).toEqual([{ name: "ms_slow" }]);
  });

  describe("PRAGMA foreign_keys", () => {
    /** Rebuilds the parent table with foreign keys off, as SQLite documents it. */
    class RebuildParent extends Migration {
      static transactional: boolean | undefined = undefined;
      get transaction() {
        return RebuildParent.transactional;
      }
      async up(ctx: MigrationContext) {
        await ctx.query("PRAGMA foreign_keys = OFF");
        await ctx.query('CREATE TABLE "ms_parent_new" ("id" INTEGER PRIMARY KEY, "name" TEXT, "extra" TEXT)');
        await ctx.query('INSERT INTO "ms_parent_new" ("id", "name") SELECT "id", "name" FROM "ms_parent"');
        await ctx.query('DROP TABLE "ms_parent"');
        await ctx.query('ALTER TABLE "ms_parent_new" RENAME TO "ms_parent"');
        await ctx.query("PRAGMA foreign_keys = ON");
      }
      async down() {}
    }

    beforeEach(async () => {
      RebuildParent.transactional = undefined;
      await connector.query('CREATE TABLE "ms_parent" ("id" INTEGER PRIMARY KEY, "name" TEXT)');
      await connector.query(
        'CREATE TABLE "ms_child" ("id" INTEGER PRIMARY KEY, "parent_id" INTEGER REFERENCES "ms_parent"("id") ON DELETE CASCADE)',
      );
      await connector.query(`INSERT INTO "ms_parent" ("id", "name") VALUES (1, 'p')`);
      await connector.query(`INSERT INTO "ms_child" ("id", "parent_id") VALUES (10, 1)`);
    });

    it("is refused inside the transaction, which ignores it, and nothing is applied", async () => {
      const [result] = await runner([new RebuildParent()]).runAll();

      expect(result.success).toBe(false);
      expect(result.error).toContain("PRAGMA foreign_keys has no effect inside a transaction");
      expect(result.error).toContain("transaction = false");
      expect(await columns("ms_parent")).toEqual(["id", "name"]);
      expect(await connector.query('SELECT "id" FROM "ms_child"')).toEqual([{ id: 10 }]);
      expect(await recorded()).toEqual([]);
    });

    it("runs in a migration that sets transaction = false, keeping the child rows", async () => {
      RebuildParent.transactional = false;

      const [result] = await runner([new RebuildParent()]).runAll();

      expect(result.success).toBe(true);
      expect(await columns("ms_parent")).toEqual(["id", "name", "extra"]);
      expect(await connector.query('SELECT "id", "parent_id" FROM "ms_child"')).toEqual([
        { id: 10, parent_id: 1 },
      ]);
      expect(await connector.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    });
  });

  it("runs a migration that sets transaction = false one statement at a time and names what stayed applied", async () => {
    class Unwrapped extends Migration {
      readonly transaction = false;
      async up(ctx: MigrationContext) {
        await ctx.query('CREATE TABLE "ms_u" ("id" INTEGER PRIMARY KEY)');
        await ctx.query("SELECT * FROM ms_no_such_table");
      }
      async down() {}
    }

    const [result] = await runner([new Unwrapped()]).runAll();

    expect(result.success).toBe(false);
    expect(result.error).toContain("no such table: ms_no_such_table");
    expect(result.error).toContain("It ran outside a transaction (it sets `transaction = false`)");
    expect(result.error).toContain(
      'what it ran before failing stays applied, including this statement from context.query:\n  CREATE TABLE "ms_u"',
    );
    expect(await tableExists("ms_u")).toBe(true);
    expect(await recorded()).toEqual([]);
  });
});
