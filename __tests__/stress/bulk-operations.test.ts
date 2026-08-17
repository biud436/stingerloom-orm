/**
 * Bulk data stress test
 *
 * Uses SQLite in-memory to measure the performance of 10,000 INSERT/DELETE operations.
 * Skipped unless STRESS_TEST=true is set.
 *
 * - Section A: Raw SQL baseline (uses connector.query directly)
 * - Section B: ORM API (uses EntityManager.save/find/delete)
 * - Section C: Repository pattern (uses BaseRepository)
 *
 * @example
 *   pnpm test:stress                       # all stress suites
 *   STRESS_TEST=true npx jest --testPathPattern "stress/bulk" --runInBand
 */

import "reflect-metadata";
import { budget } from "./stress-budget";
import { SqliteConnector } from "../../src/dialects/sqlite/SqliteConnector";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

const SKIP = process.env.STRESS_TEST !== "true";
const describeIf = SKIP ? describe.skip : describe;

// ── Section A: Raw SQL baseline ──────────────────────────────────────

describeIf("[Stress] A. Raw SQL baseline (connector.query)", () => {
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

    const rows = await connector.query(
      `SELECT COUNT(*) as cnt FROM "${tableName}"`,
    );
    expect(rows[0].cnt).toBe(BATCH_SIZE);
    expect(elapsed).toBeLessThan(budget(10_000));
  }, 30000);

  it(`${BATCH_SIZE}건을 트랜잭션으로 배치 INSERT하면 개별보다 빨라야 한다`, async () => {
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

    const rows = await connector.query(
      `SELECT COUNT(*) as cnt FROM "${tableName}"`,
    );
    expect(rows[0].cnt).toBe(BATCH_SIZE);
    expect(elapsed).toBeLessThan(budget(5_000));
  }, 30000);

  it(`${BATCH_SIZE}건 DELETE가 5초 이내에 완료되어야 한다`, async () => {
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
    expect(elapsed).toBeLessThan(budget(5_000));
  }, 30000);

  it(`${BATCH_SIZE}건 조회가 2초 이내에 완료되어야 한다`, async () => {
    const db = await connector.getConnection();
    await connector.startTransaction(db);
    for (let i = 0; i < BATCH_SIZE; i++) {
      await connector.query(
        `INSERT INTO "${tableName}" ("name", "value") VALUES ('query_${i}', ${i})`,
        db,
      );
    }
    await connector.commit(db);

    const start = Date.now();
    const rows = await connector.query(`SELECT * FROM "${tableName}"`);
    const elapsed = Date.now() - start;

    console.log(
      `[Stress] ${BATCH_SIZE}건 SELECT *: ${elapsed}ms`,
    );

    expect(rows.length).toBe(BATCH_SIZE);
    expect(elapsed).toBeLessThan(budget(2_000));
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
    expect(elapsed).toBeLessThan(budget(2_000));
  }, 10000);
});

// ── Section B: ORM API (EntityManager) ───────────────────────────────

@Entity()
class StressBulkItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "int" })
  value!: number;
}

describeIf("[Stress] B. ORM API (EntityManager.save/find/delete)", () => {
  let em: EntityManager;
  const BATCH_SIZE = 1_000; // ORM has per-entity overhead, so use smaller batch

  beforeAll(async () => {
    em = new EntityManager();
    await em.register({
      type: "sqlite",
      database: ":memory:",
      logging: false,
      synchronize: true,
      entities: [StressBulkItem],
    } as DatabaseClientOptions);
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it(`${BATCH_SIZE}건 em.save() INSERT가 30초 이내에 완료되어야 한다`, async () => {
    const start = Date.now();

    for (let i = 0; i < BATCH_SIZE; i++) {
      await em.save(StressBulkItem, { name: `orm_item_${i}`, value: i });
    }

    const elapsed = Date.now() - start;
    console.log(
      `[Stress] ORM ${BATCH_SIZE}건 em.save(): ${elapsed}ms (${Math.round(BATCH_SIZE / (elapsed / 1000))} ops/s)`,
    );

    const [, count] = await em.findAndCount(StressBulkItem);
    expect(count).toBe(BATCH_SIZE);
    expect(elapsed).toBeLessThan(budget(30_000));
  }, 60000);

  it(`${BATCH_SIZE}건 em.find() 전체 조회가 5초 이내에 완료되어야 한다`, async () => {
    const start = Date.now();
    const rows = await em.find(StressBulkItem);
    const elapsed = Date.now() - start;

    console.log(
      `[Stress] ORM ${BATCH_SIZE}건 em.find(): ${elapsed}ms`,
    );

    expect(rows.length).toBe(BATCH_SIZE);
    expect(elapsed).toBeLessThan(budget(5_000));
  }, 10000);

  it("em.find() WHERE 조건 조회가 합리적 시간 내 완료되어야 한다", async () => {
    const start = Date.now();
    const rows = await em.find(StressBulkItem, {
      where: { value: 500 } as any,
    });
    const elapsed = Date.now() - start;

    console.log(
      `[Stress] ORM WHERE 조회: ${elapsed}ms (${rows.length}건)`,
    );

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(budget(5_000));
  }, 10000);

  it(`${BATCH_SIZE}건 em.delete() 개별 삭제가 30초 이내에 완료되어야 한다`, async () => {
    const allItems = await em.find(StressBulkItem);
    const start = Date.now();

    for (const item of allItems) {
      await em.delete(StressBulkItem, { id: (item as any).id } as any);
    }

    const elapsed = Date.now() - start;
    console.log(
      `[Stress] ORM ${BATCH_SIZE}건 em.delete(): ${elapsed}ms (${Math.round(BATCH_SIZE / (elapsed / 1000))} ops/s)`,
    );

    const [, count] = await em.findAndCount(StressBulkItem);
    expect(count).toBe(0);
    expect(elapsed).toBeLessThan(budget(30_000));
  }, 60000);
});

// ── Section C: Repository pattern ──────────────────────────────────────

describeIf("[Stress] C. Repository 패턴 (BaseRepository)", () => {
  let em: EntityManager;
  let repo: BaseRepository<StressBulkItem>;
  const BATCH_SIZE = 500;

  beforeAll(async () => {
    em = new EntityManager();
    await em.register({
      type: "sqlite",
      database: ":memory:",
      logging: false,
      synchronize: true,
      entities: [StressBulkItem],
    } as DatabaseClientOptions);
    repo = new BaseRepository(StressBulkItem, em);
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it(`${BATCH_SIZE}건 repo.save() INSERT`, async () => {
    const start = Date.now();

    for (let i = 0; i < BATCH_SIZE; i++) {
      await repo.save({ name: `repo_item_${i}`, value: i } as any);
    }

    const elapsed = Date.now() - start;
    console.log(
      `[Stress] Repo ${BATCH_SIZE}건 save(): ${elapsed}ms (${Math.round(BATCH_SIZE / (elapsed / 1000))} ops/s)`,
    );

    const [, count] = await repo.findAndCount();
    expect(count).toBe(BATCH_SIZE);
    expect(elapsed).toBeLessThan(budget(30_000));
  }, 60000);

  it(`${BATCH_SIZE}건 repo.find() 전체 조회`, async () => {
    const start = Date.now();
    const rows = await repo.find();
    const elapsed = Date.now() - start;

    console.log(
      `[Stress] Repo ${BATCH_SIZE}건 find(): ${elapsed}ms`,
    );

    expect(rows.length).toBe(BATCH_SIZE);
    expect(elapsed).toBeLessThan(budget(5_000));
  }, 10000);

  it(`${BATCH_SIZE}건 repo.findOne() 개별 조회`, async () => {
    const start = Date.now();

    for (let i = 1; i <= Math.min(100, BATCH_SIZE); i++) {
      const item = await repo.findOne({ where: { id: i } as any });
      expect(item).not.toBeNull();
    }

    const elapsed = Date.now() - start;
    console.log(
      `[Stress] Repo 100건 findOne(): ${elapsed}ms`,
    );

    expect(elapsed).toBeLessThan(budget(10_000));
  }, 15000);
});
