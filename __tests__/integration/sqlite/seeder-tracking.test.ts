/**
 * SQLite In-Memory: SeederRunner tracking-table regression (V3-T2-1 probe).
 *
 * Before the fix, `ensureSeedTable()` shared the PostgreSQL DDL with SQLite:
 * `"id" SERIAL PRIMARY KEY`. On SQLite a non-INTEGER PK is not a rowid alias,
 * so every tracked row stored `id = NULL` — `ORDER BY id` gave no guaranteed
 * execution order, which is what `revertLast()` and `status()` rely on.
 * These tests run the real `better-sqlite3` driver and pin the id sequence.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { Seeder, SeederContext, SeederRunner } from "../../../src/seeding";

describe("[Integration] SQLite In-Memory: SeederRunner tracking", () => {
  let conn: TestConnectionResult;
  let SeedUser: new () => { id: number; email: string };

  class FirstSeeder extends Seeder {
    async run(ctx: SeederContext): Promise<void> {
      await ctx.em.save(SeedUser, { email: "first@example.com" });
    }
    async revert(ctx: SeederContext): Promise<void> {
      await ctx.em.delete(SeedUser, { email: "first@example.com" });
    }
  }

  class SecondSeeder extends Seeder {
    async run(ctx: SeederContext): Promise<void> {
      await ctx.em.save(SeedUser, { email: "second@example.com" });
    }
    async revert(ctx: SeederContext): Promise<void> {
      await ctx.em.delete(SeedUser, { email: "second@example.com" });
    }
  }

  beforeEach(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:" },
      () => {
        @Entity({ name: "seed_users" })
        class SeedUserEntity {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "varchar", length: 255 })
          email!: string;
        }
        SeedUser = SeedUserEntity;
        return { entities: [SeedUserEntity] };
      },
    );
  });

  afterEach(async () => {
    await conn.cleanup();
  });

  function createRunner(): SeederRunner {
    return new SeederRunner(
      [new FirstSeeder(), new SecondSeeder()],
      conn.em,
      { query: (sql: string) => conn.em.query(sql) },
    );
  }

  it("tracked rows get real auto-increment ids (fail-before: all NULL)", async () => {
    const runner = createRunner();
    const results = await runner.runAll();
    expect(results.map((r) => r.success)).toEqual([true, true]);

    const rows = await conn.em.query<{ id: number; name: string }>(
      'SELECT "id", "name" FROM "__seeds" ORDER BY "id" ASC',
    );
    expect(rows).toEqual([
      { id: 1, name: "FirstSeeder" },
      { id: 2, name: "SecondSeeder" },
    ]);
  });

  it("revertLast reverts the most recent seeder and keeps order on re-run", async () => {
    const runner = createRunner();
    await runner.runAll();

    const reverted = await runner.revertLast();
    expect(reverted).toMatchObject({ name: "SecondSeeder", success: true });
    expect(await runner.getExecutedSeeds()).toEqual(["FirstSeeder"]);

    // Re-running executes only the reverted seeder again; AUTOINCREMENT
    // guarantees the fresh row sorts after the surviving one.
    await runner.runAll();
    expect(await runner.getExecutedSeeds()).toEqual([
      "FirstSeeder",
      "SecondSeeder",
    ]);
    const again = await runner.revertLast();
    expect(again).toMatchObject({ name: "SecondSeeder", success: true });
  });

  it("status reports executed/pending from the tracking table", async () => {
    const runner = createRunner();
    await runner.runAll();
    await runner.revertLast();

    const status = await runner.status();
    expect(status.executed).toEqual(["FirstSeeder"]);
    expect(status.pending).toEqual(["SecondSeeder"]);
  });
});
