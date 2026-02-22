/**
 * 집계 함수 통합 테스트
 *
 * EntityManager와 BaseRepository의 집계 함수를 검증합니다.
 * - count(): 엔티티 수 카운트
 * - sum(): 숫자 필드 합계
 * - avg(): 숫자 필드 평균
 * - min(): 숫자 필드 최솟값
 * - max(): 숫자 필드 최댓값
 *
 * 실행 전 필요 사항:
 * - MySQL 서버 실행 중
 * - examples/nestjs-cats/.env의 연결 정보가 유효
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  createCrudTestEntity,
  DynamicEntityResult,
} from "./helpers/create-test-entity";

describe("[Integration] 집계 함수 (count/sum/avg/min/max)", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: DynamicEntityResult;
  let repo: BaseRepository<any>;

  beforeAll(async () => {
    conn = await createTestConnection(
      { synchronize: true, logging: false },
      () => {
        testEntity = createCrudTestEntity("agg_test");
        return { entities: [testEntity.EntityClass] };
      },
    );
    em = conn.em;
    repo = em.getRepository(testEntity.EntityClass);
  }, 30000);

  afterAll(async () => {
    try {
      await dropTestTable(testEntity.tableName);
    } catch {
      // ignore
    }
    await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    await truncateTestTable(testEntity.tableName);
  });

  // ─── 데이터 시딩 헬퍼 ─────────────────────────────────────────────────────

  async function seedData() {
    await repo.save({ name: "Alice", age: 10 });
    await repo.save({ name: "Bob", age: 20 });
    await repo.save({ name: "Charlie", age: 30 });
    await repo.save({ name: "Diana", age: 40 });
    await repo.save({ name: "Eve", age: 50 });
  }

  // ─── COUNT ────────────────────────────────────────────────────────────────

  describe("count()", () => {
    it("빈 테이블에서 count()는 0이어야 한다", async () => {
      const count = await repo.count();
      expect(count).toBe(0);
    });

    it("전체 레코드 수를 올바르게 반환해야 한다", async () => {
      await seedData();
      const count = await repo.count();
      expect(count).toBe(5);
    });

    it("조건부 count()가 정확해야 한다", async () => {
      await seedData();
      const count = await repo.count({ name: "Alice" } as any);
      expect(count).toBe(1);
    });

    it("조건에 맞는 레코드가 없으면 0이어야 한다", async () => {
      await seedData();
      const count = await repo.count({ name: "NonExistent" } as any);
      expect(count).toBe(0);
    });
  });

  // ─── SUM ──────────────────────────────────────────────────────────────────

  describe("sum()", () => {
    it("전체 age 합계를 올바르게 반환해야 한다", async () => {
      await seedData();
      const total = await repo.sum("age");
      expect(total).toBe(150); // 10+20+30+40+50
    });

    it("조건부 sum()이 정확해야 한다", async () => {
      await seedData();
      const total = await repo.sum("age", { name: "Alice" } as any);
      expect(total).toBe(10);
    });

    it("빈 테이블에서 sum()은 0이어야 한다", async () => {
      const total = await repo.sum("age");
      expect(total).toBe(0);
    });
  });

  // ─── AVG ──────────────────────────────────────────────────────────────────

  describe("avg()", () => {
    it("전체 age 평균을 올바르게 반환해야 한다", async () => {
      await seedData();
      const average = await repo.avg("age");
      expect(average).toBe(30); // (10+20+30+40+50)/5
    });

    it("빈 테이블에서 avg()는 0이어야 한다", async () => {
      const average = await repo.avg("age");
      expect(average).toBe(0);
    });
  });

  // ─── MIN ──────────────────────────────────────────────────────────────────

  describe("min()", () => {
    it("전체 age 최솟값을 올바르게 반환해야 한다", async () => {
      await seedData();
      const minimum = await repo.min("age");
      expect(minimum).toBe(10);
    });

    it("빈 테이블에서 min()은 0이어야 한다", async () => {
      const minimum = await repo.min("age");
      expect(minimum).toBe(0);
    });
  });

  // ─── MAX ──────────────────────────────────────────────────────────────────

  describe("max()", () => {
    it("전체 age 최댓값을 올바르게 반환해야 한다", async () => {
      await seedData();
      const maximum = await repo.max("age");
      expect(maximum).toBe(50);
    });

    it("빈 테이블에서 max()는 0이어야 한다", async () => {
      const maximum = await repo.max("age");
      expect(maximum).toBe(0);
    });
  });

  // ─── 복합 시나리오 ────────────────────────────────────────────────────────

  describe("복합 집계 시나리오", () => {
    it("삽입 후 count 증가, 삭제 후 count 감소", async () => {
      expect(await repo.count()).toBe(0);

      const s1 = await repo.save({ name: "A", age: 10 });
      expect(await repo.count()).toBe(1);

      await repo.save({ name: "B", age: 20 });
      expect(await repo.count()).toBe(2);

      await repo.delete({ id: s1.id } as any);
      expect(await repo.count()).toBe(1);
    });

    it("동일 데이터에 대해 sum, avg, min, max가 일관성 있는 결과를 반환해야 한다", async () => {
      await seedData();

      const sum = await repo.sum("age");
      const avg = await repo.avg("age");
      const min = await repo.min("age");
      const max = await repo.max("age");
      const count = await repo.count();

      // avg = sum / count
      expect(avg).toBeCloseTo(sum / count, 0);
      // min <= avg <= max
      expect(min).toBeLessThanOrEqual(avg);
      expect(avg).toBeLessThanOrEqual(max);
      // sum = avg * count (approximately)
      expect(sum).toBeCloseTo(avg * count, 0);
    });
  });
});
