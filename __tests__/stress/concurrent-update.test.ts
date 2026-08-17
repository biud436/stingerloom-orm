/**
 * Concurrent UPDATE race stress test
 *
 * Uses SQLite in-memory to verify sequential UPDATE races against the same record.
 * SQLite has a single writer so no deadlocks occur, but this test verifies
 * UPDATE atomicity and the correctness of the final value.
 *
 * Skipped unless STRESS_TEST=true is set.
 *
 * @example
 *   pnpm test:stress                       # all stress suites
 *   STRESS_TEST=true npx jest --testPathPattern "stress/concurrent-update" --runInBand
 */

import "reflect-metadata";
import { budget } from "./stress-budget";
import { SqliteConnector } from "../../src/dialects/sqlite/SqliteConnector";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";

const SKIP = process.env.STRESS_TEST !== "true";
const describeIf = SKIP ? describe.skip : describe;

describeIf("[Stress] 동시 UPDATE 경쟁 테스트", () => {
  let connector: SqliteConnector;
  const tableName = "stress_race";

  beforeAll(async () => {
    connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      database: ":memory:",
      logging: false,
    } as DatabaseClientOptions);

    await connector.query(`
      CREATE TABLE "${tableName}" (
        "id" INTEGER PRIMARY KEY,
        "counter" INTEGER NOT NULL DEFAULT 0,
        "version" INTEGER NOT NULL DEFAULT 0
      )
    `);
  });

  afterAll(async () => {
    await connector.close();
  });

  beforeEach(async () => {
    await connector.query(`DELETE FROM "${tableName}"`);
  });

  it("동일 레코드를 여러 번 UPDATE하면 최종 값이 정확해야 한다", async () => {
    // Initial record
    await connector.query(
      `INSERT INTO "${tableName}" ("id", "counter", "version") VALUES (1, 0, 0)`,
    );

    const UPDATE_COUNT = 1000;

    for (let i = 0; i < UPDATE_COUNT; i++) {
      await connector.query(
        `UPDATE "${tableName}" SET "counter" = "counter" + 1, "version" = "version" + 1 WHERE "id" = 1`,
      );
    }

    const rows = await connector.query(
      `SELECT * FROM "${tableName}" WHERE "id" = 1`,
    );
    expect(rows[0].counter).toBe(UPDATE_COUNT);
    expect(rows[0].version).toBe(UPDATE_COUNT);
  }, 30000);

  it("트랜잭션 내에서 동일 레코드를 여러 번 UPDATE해도 정확해야 한다", async () => {
    await connector.query(
      `INSERT INTO "${tableName}" ("id", "counter", "version") VALUES (2, 0, 0)`,
    );

    const BATCH_COUNT = 10;
    const UPDATES_PER_BATCH = 100;

    for (let batch = 0; batch < BATCH_COUNT; batch++) {
      const db = await connector.getConnection();
      await connector.startTransaction(db);

      for (let i = 0; i < UPDATES_PER_BATCH; i++) {
        await connector.query(
          `UPDATE "${tableName}" SET "counter" = "counter" + 1 WHERE "id" = 2`,
          db,
        );
      }

      await connector.commit(db);
    }

    const rows = await connector.query(
      `SELECT * FROM "${tableName}" WHERE "id" = 2`,
    );
    expect(rows[0].counter).toBe(BATCH_COUNT * UPDATES_PER_BATCH);
  }, 30000);

  it("UPDATE 경쟁 중 ROLLBACK되면 카운터가 증가하지 않아야 한다", async () => {
    await connector.query(
      `INSERT INTO "${tableName}" ("id", "counter", "version") VALUES (3, 100, 0)`,
    );

    // UPDATE then ROLLBACK inside a transaction
    const db = await connector.getConnection();
    await connector.startTransaction(db);
    await connector.query(
      `UPDATE "${tableName}" SET "counter" = "counter" + 50 WHERE "id" = 3`,
      db,
    );
    await connector.rollback(db);

    const rows = await connector.query(
      `SELECT * FROM "${tableName}" WHERE "id" = 3`,
    );
    expect(rows[0].counter).toBe(100); // Rolled back, so the original value is preserved
  }, 10000);

  it("여러 레코드에 대한 동시 UPDATE가 올바르게 처리되어야 한다", async () => {
    const RECORD_COUNT = 100;
    const UPDATE_PER_RECORD = 10;

    // Create records
    const db = await connector.getConnection();
    await connector.startTransaction(db);
    for (let i = 1; i <= RECORD_COUNT; i++) {
      await connector.query(
        `INSERT INTO "${tableName}" ("id", "counter", "version") VALUES (${100 + i}, 0, 0)`,
        db,
      );
    }
    await connector.commit(db);

    // UPDATE each record multiple times
    const start = Date.now();
    for (let u = 0; u < UPDATE_PER_RECORD; u++) {
      for (let r = 1; r <= RECORD_COUNT; r++) {
        await connector.query(
          `UPDATE "${tableName}" SET "counter" = "counter" + 1 WHERE "id" = ${100 + r}`,
        );
      }
    }
    const elapsed = Date.now() - start;

    console.log(
      `[Stress] ${RECORD_COUNT * UPDATE_PER_RECORD} UPDATE (${RECORD_COUNT} records x ${UPDATE_PER_RECORD}): ${elapsed}ms`,
    );

    // Every record's counter should equal UPDATE_PER_RECORD
    const rows = await connector.query(
      `SELECT "counter" FROM "${tableName}" WHERE "id" > 100`,
    );
    for (const row of rows) {
      expect(row.counter).toBe(UPDATE_PER_RECORD);
    }

    expect(elapsed).toBeLessThan(budget(10_000));
  }, 30000);
});
