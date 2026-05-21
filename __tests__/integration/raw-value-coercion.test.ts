/**
 * getRawMany / getRawOne `coerce` 옵션 통합 테스트 — 실제 드라이버 검증
 *
 * `mysql2` 는 `BIGINT` 와 집계 결과(`COUNT` / `SUM` / `AVG`)를 문자열로,
 * `pg` 는 `BIGINT` / `NUMERIC` 를 문자열로 surface 한다. 분석/집계 쿼리
 * 호출처가 매번 `Number(row.x)` 를 손으로 적던 보일러플레이트를, 쿼리
 * 빌더의 `coerce` 옵션이 ORM 레벨에서 정규화하는지 MySQL/PostgreSQL
 * 양쪽에서 검증한다.
 *
 * 요구사항:
 *   INTEGRATION_TEST=true (jest config gate)
 *   접근 가능한 MySQL / PostgreSQL
 *     개별 비활성화: INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { Expressions, qAlias } from "../../src";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createDynamicEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const skipReason = !process.env.INTEGRATION_TEST
  ? "INTEGRATION_TEST 환경변수가 설정되지 않음"
  : undefined;
const describeIf = skipReason ? describe.skip : describe;

describeIf.each(getTestDrivers())(
  "[Integration] getRawMany coerce 옵션 ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let testEntity: DynamicEntityResult;

    const jsonType = type === "postgres" ? "jsonb" : "json";

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          testEntity = createDynamicEntity("raw_coerce", [
            { name: "id", designType: Number, primary: true },
            { name: "amount", designType: Number, options: { type: "int" } },
            {
              name: "bigCounter",
              designType: Number,
              options: { type: "bigint" },
            },
            {
              name: "meta",
              designType: Object,
              options: { type: jsonType, nullable: true },
            },
            {
              name: "recordedAt",
              designType: Date,
              options: { type: "datetime" },
            },
          ]);
          return { entities: [testEntity.EntityClass] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      try {
        if (testEntity) await dropTestTable(testEntity.tableName);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await truncateTestTable(testEntity.tableName);
      // amounts 10/20/30 → COUNT 3, SUM 60, AVG 20.
      await em.save(testEntity.EntityClass, {
        amount: 10,
        bigCounter: 9007199254740,
        meta: { tag: "a", scores: [1, 2] },
        recordedAt: new Date("2026-05-01T08:00:00.000Z"),
      });
      await em.save(testEntity.EntityClass, {
        amount: 20,
        bigCounter: 1,
        meta: null,
        recordedAt: new Date("2026-05-02T08:00:00.000Z"),
      });
      await em.save(testEntity.EntityClass, {
        amount: 30,
        bigCounter: 42,
        meta: { tag: "c", scores: [] },
        recordedAt: new Date("2026-05-03T08:00:00.000Z"),
      });
    });

    it("coerces COUNT / SUM / AVG aggregate results to numbers", async () => {
      const e = qAlias(testEntity.EntityClass, "e") as any;
      const row = await em
        .createQueryBuilder(testEntity.EntityClass, "e")
        .select([
          Expressions.count("*").as("cnt"),
          Expressions.sum(e.amount).as("total"),
          Expressions.avg(e.amount).as("avg"),
        ])
        .getRawOne<{ cnt: number; total: number; avg: number }>({
          coerce: { cnt: "number", total: "number", avg: "number" },
        });

      expect(row).not.toBeNull();
      expect(typeof row!.cnt).toBe("number");
      expect(typeof row!.total).toBe("number");
      expect(typeof row!.avg).toBe("number");
      expect(row!.cnt).toBe(3);
      expect(row!.total).toBe(60);
      expect(row!.avg).toBe(20);
    });

    it("without coerce, the driver surfaces SUM() as a non-number", async () => {
      // The motivating problem: a SUM over an integer column comes back as
      // DECIMAL (mysql2) / bigint (pg), which both drivers surface as a
      // string. This is exactly what the coerce option compensates for.
      const e = qAlias(testEntity.EntityClass, "e") as any;
      const rawRow = await em
        .createQueryBuilder(testEntity.EntityClass, "e")
        .select([Expressions.sum(e.amount).as("total")])
        .getRawOne();

      expect(rawRow).not.toBeNull();
      expect(typeof rawRow!.total).not.toBe("number");
    });

    it("coerces a BIGINT column to a number", async () => {
      const e = qAlias(testEntity.EntityClass, "e") as any;
      const rows = await em
        .createQueryBuilder(testEntity.EntityClass, "e")
        .addOrderBy(e.amount, "ASC")
        .getRawMany<{ amount: number; bigCounter: number }>({
          coerce: { amount: "number", bigCounter: "number" },
        });

      expect(rows).toHaveLength(3);
      expect(typeof rows[0].bigCounter).toBe("number");
      expect(rows[0].bigCounter).toBe(9007199254740);
      expect(rows[2].bigCounter).toBe(42);
    });

    it("coerces a JSON column to an object and preserves null", async () => {
      const e = qAlias(testEntity.EntityClass, "e") as any;
      const rows = await em
        .createQueryBuilder(testEntity.EntityClass, "e")
        .addOrderBy(e.amount, "ASC")
        .getRawMany<{ amount: number; meta: { tag: string } | null }>({
          coerce: { amount: "number", meta: "json" },
        });

      expect(rows[0].meta).toEqual({ tag: "a", scores: [1, 2] });
      expect(rows[1].meta).toBeNull();
    });

    it("coerces a DATETIME column to a Date", async () => {
      const e = qAlias(testEntity.EntityClass, "e") as any;
      const rows = await em
        .createQueryBuilder(testEntity.EntityClass, "e")
        .addOrderBy(e.amount, "ASC")
        .getRawMany<{ recordedAt: Date }>({
          coerce: { recordedAt: "date" },
        });

      expect(rows).toHaveLength(3);
      // Every coerced value is a Date regardless of whether the driver
      // surfaced it as a Date or a string.
      for (const row of rows) {
        expect(row.recordedAt).toBeInstanceOf(Date);
        expect(Number.isNaN(row.recordedAt.getTime())).toBe(false);
      }
      // Rows were inserted on consecutive days — coercion preserves order.
      expect(rows[0].recordedAt.getTime()).toBeLessThan(
        rows[1].recordedAt.getTime(),
      );
      expect(rows[1].recordedAt.getTime()).toBeLessThan(
        rows[2].recordedAt.getTime(),
      );
    });
  },
);
