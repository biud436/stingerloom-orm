/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MigrationRunner on a real PostgreSQL / MySQL (MariaDB): pending migrations
 * applied in order and recorded, the lifecycle hooks around them, rollback,
 * and the advisory lock that keeps two runners apart.
 *
 * The lock is a session lock (`pg_advisory_lock`, `GET_LOCK`): it belongs to
 * the connection that took it, and only an unlock on that connection releases
 * it. The runner used to take it and release it through the pool, so the
 * unlock could land on another session and leave the lock held after the run
 * — the next run in the process then failed to acquire it. Whether the lock
 * is free is checked from a connection outside the ORM's pool.
 */
import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { qi } from "./helpers/driver-helpers";
import { DatabaseClient } from "../../src/DatabaseClient";
import {
  Migration,
  MigrationContext,
  MySqlMigrationRunner,
  PostgresMigrationRunner,
} from "../../src/migration";
import { AdvisoryLockError } from "../../src/errors";
import { MetadataContext } from "../../src/metadata/MetadataContext";

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** True when another session could take the lock right now. */
async function lockIsFree(type: string, options: any, lockId: string, hash: number): Promise<boolean> {
  if (type === "postgres") {
    const { Client } = require("pg");
    const client = new Client({
      host: options.host,
      port: options.port,
      user: options.username,
      password: options.password,
      database: options.database,
    });
    await client.connect();
    try {
      const taken = (await client.query("SELECT pg_try_advisory_lock($1) AS ok", [hash])).rows[0].ok;
      if (taken) await client.query("SELECT pg_advisory_unlock($1)", [hash]);
      return taken === true;
    } finally {
      await client.end();
    }
  }
  const mysql = require("mysql2/promise");
  const conn = await mysql.createConnection({
    host: options.host,
    port: options.port,
    user: options.username,
    password: options.password,
    database: options.database,
  });
  try {
    const [rows] = await conn.query("SELECT IS_USED_LOCK(?) AS holder", [lockId]);
    return rows[0].holder === null;
  } finally {
    await conn.end();
  }
}

function suite(poolMax: number) {
  return ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    const sfx = `${String(Date.now()).slice(-6)}_${poolMax}`;
    const trackingTable = `mr_mig_${sfx}`;
    const dataTable = `mr_data_${sfx}`;
    let lockId: string;
    let run = 0;
    const events: string[] = [];

    const t = (name: string) => qi(type, name);
    const sleep = type === "postgres" ? "SELECT pg_sleep(0.05)" : "SELECT SLEEP(0.05)";

    class CreateData extends Migration {
      get name() {
        return `create_data_${sfx}`;
      }
      async up(ctx: MigrationContext) {
        await ctx.query(`CREATE TABLE ${t(dataTable)} (${t("id")} INT PRIMARY KEY, ${t("v")} VARCHAR(20))`);
        // Two statements at once: on a pool, they run on different connections.
        await Promise.all([ctx.query(sleep), ctx.query("SELECT 1")]);
      }
      async down(ctx: MigrationContext) {
        await ctx.query(`DROP TABLE ${t(dataTable)}`);
      }
    }

    class SeedData extends Migration {
      get name() {
        return `seed_data_${sfx}`;
      }
      async up(ctx: MigrationContext) {
        await ctx.query(`INSERT INTO ${t(dataTable)} (${t("id")}, ${t("v")}) VALUES (1, 'seeded')`);
      }
      async down(ctx: MigrationContext) {
        await ctx.query(`DELETE FROM ${t(dataTable)} WHERE ${t("id")} = 1`);
      }
    }

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: false, logging: false, ...options, pool: { max: poolMax } } as any,
        () => ({ entities: [] }),
      );
    }, 60000);

    beforeEach(() => {
      lockId = `mr_lock_${sfx}_${++run}`;
      events.length = 0;
    });

    afterEach(async () => {
      await query(`DROP TABLE IF EXISTS ${t(dataTable)}`);
      await query(`DROP TABLE IF EXISTS ${t(trackingTable)}`);
    });

    afterAll(async () => {
      if (conn) await conn.cleanup();
    }, 30000);

    const query = (sql: string) => DatabaseClient.getInstance().getConnection().query(sql);
    const driver = () => conn.em.getDriver() as any;
    const free = () =>
      lockIsFree(type, options, lockId, type === "postgres" ? driver().hashLockId(lockId) : 0);

    const runner = (migrations: Migration[], lockTimeoutMs = 5000) => {
      const Runner = type === "postgres" ? PostgresMigrationRunner : MySqlMigrationRunner;
      return new Runner(migrations, driver(), { query }, {
        lockId,
        lockTimeoutMs,
        tableName: trackingTable,
        hooks: {
          beforeAll: () => {
            events.push("beforeAll");
          },
          beforeEach: (m) => {
            events.push(`beforeEach:${m.name}`);
          },
          afterEach: (m) => {
            events.push(`afterEach:${m.name}`);
          },
          onError: (m, e) => {
            events.push(`onError:${m.name}:${e.message}`);
          },
          afterAll: (_ctx, results) => {
            events.push(`afterAll:${results.length}`);
          },
        },
      });
    };

    const recorded = async (): Promise<string[]> =>
      ((await query(`SELECT ${t("name")} FROM ${t(trackingTable)} ORDER BY ${t("id")}`)) as any[]).map(
        (r) => r.name,
      );

    it("applies pending migrations in order, records them, and runs the hooks around each", async () => {
      const create = new CreateData();
      const seed = new SeedData();
      const results = await runner([create, seed]).runAll();

      expect(results.map((r) => [r.name, r.success])).toEqual([
        [create.name, true],
        [seed.name, true],
      ]);
      expect(await recorded()).toEqual([create.name, seed.name]);
      expect(await query(`SELECT ${t("v")} FROM ${t(dataTable)}`)).toEqual([{ v: "seeded" }]);
      expect(events).toEqual([
        "beforeAll",
        `beforeEach:${create.name}`,
        `afterEach:${create.name}`,
        `beforeEach:${seed.name}`,
        `afterEach:${seed.name}`,
        "afterAll:2",
      ]);

      expect(await runner([create, seed]).runAll()).toEqual([]);
    });

    it("releases the lock on the server when the run ends, so the next run takes it", async () => {
      await runner([new CreateData()]).runAll();
      expect(await free()).toBe(true);

      await expect(runner([new CreateData(), new SeedData()], 1000).runAll()).resolves.toHaveLength(1);
      expect(await free()).toBe(true);
    });

    // On a pool of one, both runners share the one session, and a session
    // lock does not exclude its own session.
    (poolMax > 1 ? it : it.skip)("keeps a second runner out while the first holds the lock", async () => {
      const entered = gate();
      const finish = gate();
      class Slow extends Migration {
        get name() {
          return `slow_${sfx}`;
        }
        async up(ctx: MigrationContext) {
          await ctx.query("SELECT 1");
          entered.open();
          await finish.promise;
        }
        async down() {}
      }

      const first = runner([new Slow()]).runAll();
      await entered.promise;
      try {
        expect(await free()).toBe(false);
        await expect(runner([new Slow()], 1000).runAll()).rejects.toBeInstanceOf(AdvisoryLockError);
      } finally {
        finish.open();
      }
      await expect(first).resolves.toHaveLength(1);
      expect(await free()).toBe(true);
    });

    it("stops at a failing migration, reports it to onError, and releases the lock", async () => {
      class Broken extends Migration {
        get name() {
          return `broken_${sfx}`;
        }
        async up(ctx: MigrationContext) {
          await ctx.query("SELECT * FROM no_such_table_for_migration_runner_real");
        }
        async down() {}
      }
      const create = new CreateData();
      const results = await runner([create, new Broken(), new SeedData()]).runAll();

      expect(results.map((r) => r.success)).toEqual([true, false]);
      expect(events.some((e) => e.startsWith(`onError:broken_${sfx}:`))).toBe(true);
      expect(await recorded()).toEqual([create.name]);
      expect(await free()).toBe(true);
    });

    // PostgreSQL rolls the whole migration back; MySQL commits each schema
    // change as it runs, so the runner says which statements stayed.
    it("leaves nothing of a migration that fails part-way on PostgreSQL, and names what stayed on MySQL", async () => {
      class HalfDone extends Migration {
        get name() {
          return `half_done_${sfx}`;
        }
        async up(ctx: MigrationContext) {
          await ctx.query(`CREATE TABLE ${t(dataTable)} (${t("id")} INT PRIMARY KEY)`);
          await ctx.query(`INSERT INTO ${t(dataTable)} (${t("id")}) VALUES (1)`);
          await ctx.query("SELECT * FROM no_such_table_for_migration_runner_real");
        }
        async down() {}
      }

      const [result] = await runner([new HalfDone()]).runAll();

      expect(result.success).toBe(false);
      expect(await recorded()).toEqual([]);
      const exists = await query(
        type === "postgres"
          ? `SELECT 1 FROM pg_tables WHERE tablename = '${dataTable}'`
          : `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${dataTable}'`,
      );
      if (type === "postgres") {
        expect(exists).toEqual([]);
        expect(result.error).not.toContain("outside a transaction");
      } else {
        expect(exists).toHaveLength(1);
        expect(result.error).toContain("It ran outside a transaction (MySQL commits each schema change as it runs)");
        expect(result.error).toContain(
          `stays applied, including these 2 statements from context.query:\n  CREATE TABLE ${t(dataTable)}`,
        );
      }
      expect(await free()).toBe(true);
    });

    (type === "postgres" ? it : it.skip)(
      "runs context.driver's helpers on the migration's connection, inside its transaction",
      async () => {
        const indexName = `mr_idx_${sfx}`;
        const seen: unknown[] = [];
        class WithHelpers extends Migration {
          static broken = true;
          get name() {
            return `with_helpers_${sfx}`;
          }
          async up(ctx: MigrationContext) {
            await ctx.query(`CREATE TABLE ${t(dataTable)} (${t("id")} INT PRIMARY KEY, ${t("v")} VARCHAR(20))`);
            // Another connection cannot see the table before COMMIT, and would
            // wait on its lock for the index.
            seen.push(await ctx.driver.hasTable(dataTable));
            await ctx.driver.addIndex(dataTable, "v", indexName);
            if (WithHelpers.broken) await ctx.query("SELECT * FROM no_such_table_for_migration_runner_real");
          }
          async down() {}
        }
        const indexes = () => query(`SELECT indexname FROM pg_indexes WHERE indexname = '${indexName}'`);

        const [failed] = await runner([new WithHelpers()]).runAll();

        expect(failed.success).toBe(false);
        expect(seen).toEqual([[{ tablename: dataTable }]]);
        expect(await indexes()).toEqual([]);
        expect(await query(`SELECT 1 FROM pg_tables WHERE tablename = '${dataTable}'`)).toEqual([]);

        WithHelpers.broken = false;
        const [applied] = await runner([new WithHelpers()]).runAll();

        expect(applied.success).toBe(true);
        expect(await indexes()).toEqual([{ indexname: indexName }]);
        expect(await recorded()).toEqual([`with_helpers_${sfx}`]);
      },
    );

    (type === "postgres" ? it : it.skip)(
      "tells a migration that cannot run in a transaction to set transaction = false, and runs it when it does",
      async () => {
        await query(`CREATE TABLE ${t(dataTable)} (${t("id")} INT PRIMARY KEY, ${t("v")} VARCHAR(20))`);
        const indexName = `mr_conc_${sfx}`;
        class Concurrent extends Migration {
          static transactional: boolean | undefined;
          get name() {
            return `concurrent_${sfx}`;
          }
          get transaction() {
            return Concurrent.transactional;
          }
          async up(ctx: MigrationContext) {
            await ctx.query(`CREATE INDEX CONCURRENTLY ${t(indexName)} ON ${t(dataTable)} (${t("v")})`);
          }
          async down() {}
        }

        const [refused] = await runner([new Concurrent()]).runAll();

        expect(refused.success).toBe(false);
        expect(refused.error).toContain("cannot run inside a transaction block");
        expect(refused.error).toContain("set `transaction = false` on it");

        Concurrent.transactional = false;
        const [applied] = await runner([new Concurrent()]).runAll();

        expect(applied.success).toBe(true);
        expect(await query(`SELECT indexname FROM pg_indexes WHERE indexname = '${indexName}'`)).toEqual([
          { indexname: indexName },
        ]);
      },
    );

    // A transaction begun for a tenant points search_path at the tenant's
    // schema; the runner reads its tracking table in the connection's schema.
    (type === "postgres" ? it : it.skip)(
      "applies a migration in the connection's schema when the runner is called for a tenant",
      async () => {
        const create = new CreateData();

        const [result] = await MetadataContext.run(`mr_no_such_schema_${sfx}`, () =>
          runner([create]).runAll(),
        );

        expect(result).toEqual({ name: create.name, direction: "up", success: true });
        expect(await recorded()).toEqual([create.name]);
        expect(await query(`SELECT 1 AS ok FROM pg_tables WHERE tablename = '${dataTable}'`)).toEqual([{ ok: 1 }]);
      },
    );

    (type === "mysql" ? it : it.skip)("rolls back a data-only migration that sets transaction = true on MySQL", async () => {
      await query(`CREATE TABLE ${t(dataTable)} (${t("id")} INT PRIMARY KEY, ${t("v")} VARCHAR(20))`);
      class SeedTwice extends Migration {
        readonly transaction = true;
        get name() {
          return `seed_twice_${sfx}`;
        }
        async up(ctx: MigrationContext) {
          await ctx.query(`INSERT INTO ${t(dataTable)} (${t("id")}, ${t("v")}) VALUES (1, 'a')`);
          await ctx.query(`INSERT INTO ${t(dataTable)} (${t("id")}, ${t("v")}) VALUES (1, 'b')`);
        }
        async down() {}
      }

      const [result] = await runner([new SeedTwice()]).runAll();

      expect(result.success).toBe(false);
      expect(await query(`SELECT ${t("id")} FROM ${t(dataTable)}`)).toEqual([]);
      expect(await recorded()).toEqual([]);
    });

    it("rolls back the last migration and its record", async () => {
      const create = new CreateData();
      const seed = new SeedData();
      await runner([create, seed]).runAll();

      const reverted = await runner([create, seed]).rollback(1);

      expect(reverted.map((r) => [r.name, r.direction, r.success])).toEqual([[seed.name, "down", true]]);
      expect(await recorded()).toEqual([create.name]);
      expect(await query(`SELECT ${t("v")} FROM ${t(dataTable)}`)).toEqual([]);
      expect(await free()).toBe(true);
    });
  };
}

describe.each(getTestDrivers())("[Integration] $label: MigrationRunner", suite(4));

describe.each(getTestDrivers())("[Integration] $label: MigrationRunner on a pool of one", suite(1));
