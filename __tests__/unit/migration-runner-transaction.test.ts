/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Migration,
  MigrationContext,
  MigrationHooks,
  MigrationQueryRunner,
  MySqlMigrationRunner,
  PostgresMigrationRunner,
  SqliteMigrationRunner,
} from "../../src/migration";
import { DriverSession, ISqlDriver } from "../../src/dialects/SqlDriver";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { MetadataContext } from "../../src/metadata/MetadataContext";

interface Harness {
  driver: ISqlDriver;
  sessionDriver: ISqlDriver;
  queryRunner: MigrationQueryRunner;
  /** Everything in order: BEGIN/COMMIT/ROLLBACK, `tx:` and `pool:` statements, hooks. */
  events: string[];
  hooks: MigrationHooks;
  errors: unknown[];
}

/** A driver that can open a transaction, unless `transactional` is false. */
function harness(options: { transactional?: boolean; failOn?: string | Error } = {}): Harness {
  const events: string[] = [];
  const errors: unknown[] = [];
  const sessionDriver = { session: true } as unknown as ISqlDriver;
  const fail = (sql: string) => {
    const { failOn } = options;
    if (failOn === undefined) return;
    const needle = typeof failOn === "string" ? failOn : failOn.message;
    if (sql.includes(needle)) throw typeof failOn === "string" ? new Error(`failed: ${failOn}`) : failOn;
  };
  const driver: any = {
    acquireAdvisoryLock: jest.fn().mockResolvedValue(true),
    releaseAdvisoryLock: jest.fn().mockResolvedValue(undefined),
  };
  if (options.transactional !== false) {
    driver.runInTransaction = jest.fn(async (work: (session: DriverSession) => Promise<unknown>) => {
      events.push(`BEGIN${MetadataContext.isActive() ? ` as ${MetadataContext.getCurrentTenant()}` : ""}`);
      try {
        const result = await work({
          driver: sessionDriver,
          query: async (sql) => {
            events.push(`tx:${String(sql)}`);
            fail(String(sql));
            return [];
          },
        });
        events.push("COMMIT");
        return result;
      } catch (e) {
        events.push("ROLLBACK");
        throw e;
      }
    });
  }
  const queryRunner: MigrationQueryRunner = {
    query: jest.fn(async (sql: string) => {
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS") || sql.startsWith("SELECT")) return [];
      events.push(`pool:${sql}`);
      fail(sql);
      return [];
    }),
  };
  const hooks: MigrationHooks = {
    beforeEach: (m) => {
      events.push(`beforeEach:${m.name}`);
    },
    afterEach: (m) => {
      events.push(`afterEach:${m.name}`);
    },
    onError: (m, e) => {
      events.push(`onError:${m.name}`);
      errors.push(e);
    },
  };
  return { driver, sessionDriver, queryRunner, events, hooks, errors };
}

class AddTable extends Migration {
  static seenDriver: ISqlDriver | undefined;
  get name() {
    return "add_table";
  }
  async up(ctx: MigrationContext) {
    AddTable.seenDriver = ctx.driver;
    await ctx.query("CREATE TABLE t (id INT)");
    await ctx.query("ALTER TABLE t ADD COLUMN v INT");
  }
  async down(ctx: MigrationContext) {
    AddTable.seenDriver = ctx.driver;
    await ctx.query("DROP TABLE t");
  }
}

function withTransaction(value: boolean | undefined): Migration {
  return new (class extends AddTable {
    readonly transaction = value;
  })();
}

describe("MigrationRunner transactions", () => {
  beforeEach(() => {
    AddTable.seenDriver = undefined;
  });

  it("applies a migration and writes its tracking row in one transaction, between the hooks", async () => {
    const h = harness();
    const runner = new PostgresMigrationRunner([new AddTable()], h.driver, h.queryRunner, { hooks: h.hooks });

    const results = await runner.runAll();

    expect(results).toEqual([{ name: "add_table", direction: "up", success: true }]);
    expect(h.events).toEqual([
      "beforeEach:add_table",
      "BEGIN as public",
      "tx:CREATE TABLE t (id INT)",
      "tx:ALTER TABLE t ADD COLUMN v INT",
      `tx:INSERT INTO "__migrations" ("name") VALUES ('add_table')`,
      "COMMIT",
      "afterEach:add_table",
    ]);
    expect(AddTable.seenDriver).toBe(h.sessionDriver);
  });

  it("opens the transaction outside the tenant the runner was called for", async () => {
    const h = harness();
    const runner = new PostgresMigrationRunner([new AddTable()], h.driver, h.queryRunner);

    await MetadataContext.run("acme", () => runner.runAll());

    expect(h.events[0]).toBe("BEGIN as public");
  });

  it("reverts a migration and deletes its tracking row in one transaction", async () => {
    const h = harness();
    const runner = new SqliteMigrationRunner([new AddTable()], h.driver, h.queryRunner);

    const result = await runner.runDown(new AddTable());

    expect(result).toEqual({ name: "add_table", direction: "down", success: true });
    expect(h.events).toEqual([
      "BEGIN as public",
      "tx:DROP TABLE t",
      `tx:DELETE FROM "__migrations" WHERE "name" = 'add_table'`,
      "COMMIT",
    ]);
    expect(AddTable.seenDriver).toBe(h.sessionDriver);
  });

  it("rolls back and reports a failure, calling onError with the driver's error", async () => {
    const error = new Error("ADD COLUMN v");
    const h = harness({ failOn: error });
    const runner = new PostgresMigrationRunner([new AddTable()], h.driver, h.queryRunner, { hooks: h.hooks });

    const [result] = await runner.runAll();

    expect(result).toEqual({ name: "add_table", direction: "up", success: false, error: "ADD COLUMN v" });
    expect(h.events).toEqual([
      "beforeEach:add_table",
      "BEGIN as public",
      "tx:CREATE TABLE t (id INT)",
      "tx:ALTER TABLE t ADD COLUMN v INT",
      "ROLLBACK",
      "onError:add_table",
    ]);
    expect(h.errors).toEqual([error]);
  });

  it("rolls the migration back when its tracking row cannot be written", async () => {
    const h = harness({ failOn: "INSERT INTO" });
    const runner = new PostgresMigrationRunner([new AddTable()], h.driver, h.queryRunner, { hooks: h.hooks });

    const [result] = await runner.runAll();

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tracking failed: failed: INSERT INTO");
    expect(h.events.slice(-2)).toEqual(["ROLLBACK", "onError:add_table"]);
    expect((h.errors[0] as Error).message).toBe("failed: INSERT INTO");
  });

  it("tells a migration whose statement cannot run in a transaction to set transaction = false", async () => {
    const h = harness({ failOn: new Error("CREATE INDEX CONCURRENTLY cannot run inside a transaction block") });
    class Concurrently extends Migration {
      async up(ctx: MigrationContext) {
        await ctx.query("CREATE INDEX CONCURRENTLY cannot run inside a transaction block");
      }
      async down() {}
    }
    const runner = new PostgresMigrationRunner([new Concurrently()], h.driver, h.queryRunner);

    const [result] = await runner.runAll();

    expect(result.error).toBe(
      "CREATE INDEX CONCURRENTLY cannot run inside a transaction block. The migration ran in a " +
        "transaction, which this statement cannot run in; set `transaction = false` on it to run its " +
        "statements one at a time",
    );
  });

  it("runs a migration that sets transaction = false one statement at a time", async () => {
    const h = harness();
    const runner = new PostgresMigrationRunner([withTransaction(false)], h.driver, h.queryRunner);

    expect((await runner.runAll())[0].success).toBe(true);
    expect(h.driver.runInTransaction).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      "pool:CREATE TABLE t (id INT)",
      "pool:ALTER TABLE t ADD COLUMN v INT",
      `pool:INSERT INTO "__migrations" ("name") VALUES ('add_table')`,
    ]);
    expect(AddTable.seenDriver).toBe(h.driver);
  });

  it("names the statements that stayed applied when a migration outside a transaction fails", async () => {
    const h = harness({ failOn: "ADD COLUMN" });
    const long = `INSERT INTO t VALUES ${"(1),".repeat(80)}(1)`;
    class Seeds extends Migration {
      readonly transaction = false;
      async up(ctx: MigrationContext) {
        await ctx.query("CREATE TABLE t (\n  id INT\n)");
        await ctx.query(long);
        await ctx.query("ALTER TABLE t ADD COLUMN v INT");
      }
      async down() {}
    }
    const runner = new PostgresMigrationRunner([new Seeds()], h.driver, h.queryRunner);

    const [result] = await runner.runAll();

    expect(result.error).toBe(
      "failed: ADD COLUMN. It ran outside a transaction (it sets `transaction = false`), so what it " +
        "ran before failing stays applied, including these 2 statements from context.query:\n" +
        "  CREATE TABLE t ( id INT )\n" +
        `  ${long.slice(0, 197)}...`,
    );
  });

  describe("on MySQL", () => {
    it("runs a migration one statement at a time unless it sets transaction = true", async () => {
      const h = harness({ failOn: "ADD COLUMN" });
      const runner = new MySqlMigrationRunner([new AddTable()], h.driver, h.queryRunner);

      const [result] = await runner.runAll();

      expect(h.driver.runInTransaction).not.toHaveBeenCalled();
      expect(result.error).toBe(
        "failed: ADD COLUMN. It ran outside a transaction (MySQL commits each schema change as it " +
          "runs), so what it ran before failing stays applied, including this statement from " +
          "context.query:\n  CREATE TABLE t (id INT)",
      );
    });

    it("runs a migration that sets transaction = true in a transaction", async () => {
      const h = harness();
      const runner = new MySqlMigrationRunner([withTransaction(true)], h.driver, h.queryRunner);

      expect((await runner.runAll())[0].success).toBe(true);
      expect(h.events[0]).toBe("BEGIN as public");
      expect(h.events[h.events.length - 1]).toBe("COMMIT");
    });
  });

  describe("with a driver that cannot open a transaction", () => {
    it("runs a migration that does not ask for one statement at a time", async () => {
      const h = harness({ transactional: false, failOn: "ADD COLUMN" });
      const runner = new PostgresMigrationRunner([new AddTable()], h.driver, h.queryRunner);

      const [result] = await runner.runAll();

      expect(result.error).toContain("It ran outside a transaction (its driver cannot open a transaction)");
    });

    it("fails a migration that sets transaction = true before it runs anything", async () => {
      const h = harness({ transactional: false });
      const runner = new PostgresMigrationRunner([withTransaction(true)], h.driver, h.queryRunner, {
        hooks: h.hooks,
      });

      const [result] = await runner.runAll();

      expect(result).toEqual({
        name: "add_table",
        direction: "up",
        success: false,
        error: 'Migration "add_table" sets `transaction = true`, but its driver cannot open a transaction.',
      });
      expect(h.events).toEqual(["beforeEach:add_table", "onError:add_table"]);
      expect(h.errors[0]).toBeInstanceOf(OrmError);
      expect((h.errors[0] as OrmError).code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
    });
  });

  describe("PRAGMA foreign_keys on SQLite", () => {
    const run = async (statement: string) => {
      const h = harness();
      class Pragma extends Migration {
        async up(ctx: MigrationContext) {
          await ctx.query(statement);
        }
        async down() {}
      }
      const [result] = await new SqliteMigrationRunner([new Pragma()], h.driver, h.queryRunner).runAll();
      return { result, events: h.events };
    };

    it.each([
      "PRAGMA foreign_keys = OFF",
      "pragma foreign_keys=0",
      "PRAGMA main.foreign_keys = OFF",
      'PRAGMA "foreign_keys" = ON',
      "PRAGMA foreign_keys(OFF)",
      "CREATE TABLE a (id INT); PRAGMA foreign_keys = OFF",
    ])("refuses %j inside a transaction before it runs", async (statement) => {
      const { result, events } = await run(statement);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "PRAGMA foreign_keys has no effect inside a transaction, and this migration runs in one. " +
          "Set `transaction = false` on the migration to turn foreign keys off around a table rebuild, " +
          "or use PRAGMA defer_foreign_keys = ON inside the transaction.",
      );
      expect(events).toEqual(["BEGIN as public", "ROLLBACK"]);
    });

    it.each(["PRAGMA foreign_keys", 'PRAGMA foreign_key_list("t")', "PRAGMA foreign_key_check", "PRAGMA defer_foreign_keys = ON"])(
      "runs %j inside a transaction",
      async (statement) => {
        const { result } = await run(statement);

        expect(result.success).toBe(true);
      },
    );
  });
});
