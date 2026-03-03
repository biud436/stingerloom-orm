/**
 * 대량 데이터 스트레스 테스트
 *
 * SQLite in-memory를 사용하여 10,000건 INSERT/DELETE 성능을 측정합니다.
 * STRESS_TEST=true 환경변수 없이는 스킵됩니다.
 *
 * @example
 *   STRESS_TEST=true pnpm test -- --testPathPattern="stress/bulk"
 */

import "reflect-metadata";
import { SqliteConnector } from "../../src/dialects/sqlite/SqliteConnector";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";

const SKIP = process.env.STRESS_TEST !== "true";
const describeIf = SKIP ? describe.skip : describe;

describeIf("[Stress] 대량 데이터 INSERT / DELETE 성능", () => {
  let connector: SqliteConnector;
  const tableName = "stress_bulk";
  const BATCH_SIZE = 10_000;

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
        "name" TEXT NOT NULL,
        "value" INTEGER NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await connector.close();
  });

  it(`${BATCH_SIZE}건 개별 INSERT가 10초 이내에 완료되어야 한다`, async () => {
    const start = Date.now();

    for (let i = 0; i < BATCH_SIZE; i++) {
      await connector.query(
        `INSERT INTO "${tableName}" ("name", "value") VALUES ('item_${i}', ${i})`,
      );
    }

    const elapsed = Date.now() - start;
    console.log(
      `[Stress] ${BATCH_SIZE}건 개별 INSERT: ${elapsed}ms (${Math.round(BATCH_SIZE / (elapsed / 1000))} ops/s)`,
    );

    // 검증
    const rows = await connector.query(
      `SELECT COUNT(*) as cnt FROM "${tableName}"`,
    );
    expect(rows[0].cnt).toBe(BATCH_SIZE);

    // 10초 이내
    expect(elapsed).toBeLessThan(10_000);
  }, 30000);

  it(`${BATCH_SIZE}건을 트랜잭션으로 배치 INSERT하면 개별보다 빨라야 한다`, async () => {
    // 기존 데이터 정리
    await connector.query(`DELETE FROM "${tableName}"`);

    const db = await connector.getConnection();
    const start = Date.now();

    await connector.startTransaction(db);
    for (let i = 0; i < BATCH_SIZE; i++) {
      await connector.query(
        `INSERT INTO "${tableName}" ("name", "value") VALUES ('batch_${i}', ${i})`,
        db,
      );
    }
    await connector.commit(db);

    const elapsed = Date.now() - start;
    console.log(
      `[Stress] ${BATCH_SIZE}건 배치 INSERT (트랜잭션): ${elapsed}ms (${Math.round(BATCH_SIZE / (elapsed / 1000))} ops/s)`,
    );

    // 검증
    const rows = await connector.query(
      `SELECT COUNT(*) as cnt FROM "${tableName}"`,
    );
    expect(rows[0].cnt).toBe(BATCH_SIZE);

    // 배치 INSERT는 5초 이내
    expect(elapsed).toBeLessThan(5_000);
  }, 30000);

  it(`${BATCH_SIZE}건 DELETE가 5초 이내에 완료되어야 한다`, async () => {
    // 데이터가 있는지 확인
    const before = await connector.query(
      `SELECT COUNT(*) as cnt FROM "${tableName}"`,
    );
    expect(before[0].cnt).toBe(BATCH_SIZE);

    const start = Date.now();
    const result = await connector.query(`DELETE FROM "${tableName}"`);
    const elapsed = Date.now() - start;

    console.log(
      `[Stress] ${BATCH_SIZE}건 DELETE: ${elapsed}ms`,
    );

    expect(result.changes).toBe(BATCH_SIZE);
    expect(elapsed).toBeLessThan(5_000);
  }, 30000);

  it(`${BATCH_SIZE}건 조회가 2초 이내에 완료되어야 한다`, async () => {
    // 데이터 재생성 (배치)
    const db = await connector.getConnection();
    await connector.startTransaction(db);
    for (let i = 0; i < BATCH_SIZE; i++) {
      await connector.query(
        `INSERT INTO "${tableName}" ("name", "value") VALUES ('query_${i}', ${i})`,
        db,
      );
    }
    await connector.commit(db);

    // 전체 조회 성능
    const start = Date.now();
    const rows = await connector.query(`SELECT * FROM "${tableName}"`);
    const elapsed = Date.now() - start;

    console.log(
      `[Stress] ${BATCH_SIZE}건 SELECT *: ${elapsed}ms`,
    );

    expect(rows.length).toBe(BATCH_SIZE);
    expect(elapsed).toBeLessThan(2_000);
  }, 30000);

  it("WHERE 조건 조회가 인덱스 없이도 합리적 시간 내 완료되어야 한다", async () => {
    const start = Date.now();
    const rows = await connector.query(
      `SELECT * FROM "${tableName}" WHERE "value" BETWEEN 5000 AND 5099`,
    );
    const elapsed = Date.now() - start;

    console.log(
      `[Stress] WHERE 범위 조회 (100건): ${elapsed}ms`,
    );

    expect(rows.length).toBe(100);
    expect(elapsed).toBeLessThan(2_000);
  }, 10000);
});
