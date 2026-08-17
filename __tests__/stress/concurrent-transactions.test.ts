/**
 * Concurrent transaction stress test
 *
 * Uses SQLite in-memory to verify multiple concurrent transaction scenarios.
 * SQLite has a single writer so concurrency is limited, but this test
 * verifies data integrity across sequential transactions.
 *
 * Skipped unless STRESS_TEST=true is set.
 *
 * @example
 *   pnpm test:stress                       # all stress suites
 *   STRESS_TEST=true npx jest --testPathPattern "stress/concurrent" --runInBand
 */

import "reflect-metadata";
import { budget } from "./stress-budget";
import { SqliteConnector } from "../../src/dialects/sqlite/SqliteConnector";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";

const SKIP = process.env.STRESS_TEST !== "true";
const describeIf = SKIP ? describe.skip : describe;

describeIf("[Stress] 동시 트랜잭션 테스트", () => {
  let connector: SqliteConnector;
  const tableName = "stress_concurrent";

  beforeAll(async () => {
    connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      database: ":memory:",
      logging: false,
    } as DatabaseClientOptions);

    await connector.query(`
      CREATE TABLE "${tableName}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "counter" INTEGER NOT NULL DEFAULT 0,
        "worker" TEXT NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await connector.close();
  });

  beforeEach(async () => {
    await connector.query(`DELETE FROM "${tableName}"`);
  });

  it("순차적으로 여러 트랜잭션을 실행하면 데이터가 모두 반영되어야 한다", async () => {
    const TRANSACTION_COUNT = 50;

    for (let i = 0; i < TRANSACTION_COUNT; i++) {
      const db = await connector.getConnection();
      await connector.startTransaction(db);
      await connector.query(
        `INSERT INTO "${tableName}" ("counter", "worker") VALUES (${i}, 'worker_${i}')`,
        db,
      );
      await connector.commit(db);
    }

    const rows = await connector.query(
      `SELECT COUNT(*) as cnt FROM "${tableName}"`,
    );
    expect(rows[0].cnt).toBe(TRANSACTION_COUNT);
  }, 30000);

  it("트랜잭션 ROLLBACK과 COMMIT이 번갈아 실행되어도 데이터 무결성이 유지되어야 한다", async () => {
    const ITERATIONS = 100;
    let expectedCount = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const db = await connector.getConnection();
      await connector.startTransaction(db);
      await connector.query(
        `INSERT INTO "${tableName}" ("counter", "worker") VALUES (${i}, 'mixed_${i}')`,
        db,
      );

      if (i % 3 === 0) {
        // Multiples of 3 → ROLLBACK
        await connector.rollback(db);
      } else {
        // Otherwise COMMIT
        await connector.commit(db);
        expectedCount++;
      }
    }

    const rows = await connector.query(
      `SELECT COUNT(*) as cnt FROM "${tableName}"`,
    );
    expect(rows[0].cnt).toBe(expectedCount);
  }, 30000);

  it("대량 순차 트랜잭션이 빠르게 완료되어야 한다", async () => {
    const TRANSACTION_COUNT = 200;
    const start = Date.now();

    for (let i = 0; i < TRANSACTION_COUNT; i++) {
      const db = await connector.getConnection();
      await connector.startTransaction(db);
      await connector.query(
        `INSERT INTO "${tableName}" ("counter", "worker") VALUES (${i}, 'perf_${i}')`,
        db,
      );
      await connector.commit(db);
    }

    const elapsed = Date.now() - start;
    console.log(
      `[Stress] ${TRANSACTION_COUNT} 순차 트랜잭션: ${elapsed}ms (${Math.round(TRANSACTION_COUNT / (elapsed / 1000))} txn/s)`,
    );

    const rows = await connector.query(
      `SELECT COUNT(*) as cnt FROM "${tableName}"`,
    );
    expect(rows[0].cnt).toBe(TRANSACTION_COUNT);
    expect(elapsed).toBeLessThan(budget(10_000));
  }, 30000);
});
