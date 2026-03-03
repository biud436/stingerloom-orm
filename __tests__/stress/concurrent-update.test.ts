/**
 * 동시 UPDATE 경쟁 스트레스 테스트
 *
 * SQLite in-memory를 사용하여 동일 레코드에 대한 순차적 UPDATE 경쟁을 검증합니다.
 * SQLite는 단일 writer이므로 데드락은 발생하지 않지만,
 * UPDATE의 원자성과 최종 값의 정확성을 검증합니다.
 *
 * STRESS_TEST=true 환경변수 없이는 스킵됩니다.
 *
 * @example
 *   STRESS_TEST=true pnpm test -- --testPathPattern="stress/concurrent-update"
 */

import "reflect-metadata";
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
    // 초기 레코드
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

    // 트랜잭션 내에서 UPDATE 후 ROLLBACK
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
    expect(rows[0].counter).toBe(100); // ROLLBACK이므로 원래 값 유지
  }, 10000);

  it("여러 레코드에 대한 동시 UPDATE가 올바르게 처리되어야 한다", async () => {
    const RECORD_COUNT = 100;
    const UPDATE_PER_RECORD = 10;

    // 레코드 생성
    const db = await connector.getConnection();
    await connector.startTransaction(db);
    for (let i = 1; i <= RECORD_COUNT; i++) {
      await connector.query(
        `INSERT INTO "${tableName}" ("id", "counter", "version") VALUES (${100 + i}, 0, 0)`,
        db,
      );
    }
    await connector.commit(db);

    // 각 레코드를 여러 번 UPDATE
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

    // 모든 레코드의 counter가 UPDATE_PER_RECORD와 일치해야 함
    const rows = await connector.query(
      `SELECT "counter" FROM "${tableName}" WHERE "id" > 100`,
    );
    for (const row of rows) {
      expect(row.counter).toBe(UPDATE_PER_RECORD);
    }

    expect(elapsed).toBeLessThan(10_000);
  }, 30000);
});
