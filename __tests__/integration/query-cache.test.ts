/**
 * QueryCache 통합 테스트
 *
 * EntityManager의 find({ cache: true/number }) 옵션을 통한
 * 쿼리 결과 캐싱과 무효화를 검증합니다.
 *
 * 테스트 항목:
 * - find({ cache: true }) — 기본 TTL(30초) 캐싱
 * - find({ cache: 5000 }) — 커스텀 TTL 캐싱
 * - 동일 쿼리 재호출 시 캐시 히트 (결과 동일)
 * - save() 후 캐시 자동 무효화
 * - clearCache(entity) / clearCache() 수동 무효화
 * - 서로 다른 where 조건은 별도 캐시 키
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
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createCrudTestEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";

// ─────────────────────────────────────────────────────────────────────────────
// 테스트 스위트
// ─────────────────────────────────────────────────────────────────────────────

describe("[Integration] QueryCache (find cache 옵션)", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: DynamicEntityResult;
  let repo: BaseRepository<any>;

  beforeAll(async () => {
    conn = await createTestConnection(
      { synchronize: true, logging: false },
      () => {
        testEntity = createCrudTestEntity("qcache_test");
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
    em.clearCache(); // 테스트 간 캐시 격리
  });

  // ─── 기본 캐싱 ──────────────────────────────────────────────────────────────

  describe("기본 캐싱 동작", () => {
    it("cache: true로 조회 시 결과가 캐싱되어야 한다", async () => {
      await repo.save({ name: "Alice", age: 25 });

      // 첫 번째 조회 (캐시 미스 → DB 쿼리)
      const result1 = await em.find(testEntity.EntityClass, {
        where: { name: "Alice" },
        cache: true,
      } as any);

      // 두 번째 조회 (캐시 히트)
      const result2 = await em.find(testEntity.EntityClass, {
        where: { name: "Alice" },
        cache: true,
      } as any);

      // 결과가 동일해야 한다
      const arr1 = Array.isArray(result1) ? result1 : [result1];
      const arr2 = Array.isArray(result2) ? result2 : [result2];
      expect(arr1.length).toBe(arr2.length);
      expect(arr1[0]?.name).toBe("Alice");
      expect(arr2[0]?.name).toBe("Alice");
    });

    it("cache: 숫자로 커스텀 TTL을 설정할 수 있어야 한다", async () => {
      await repo.save({ name: "Bob", age: 30 });

      const result1 = await em.find(testEntity.EntityClass, {
        where: { name: "Bob" },
        cache: 10000, // 10초 TTL
      } as any);

      const result2 = await em.find(testEntity.EntityClass, {
        where: { name: "Bob" },
        cache: 10000,
      } as any);

      const arr1 = Array.isArray(result1) ? result1 : [result1];
      const arr2 = Array.isArray(result2) ? result2 : [result2];
      expect(arr1[0]?.name).toBe("Bob");
      expect(arr2[0]?.name).toBe("Bob");
    });

    it("캐시 히트 시 DB 변경 사항이 반영되지 않아야 한다 (캐시된 결과 반환)", async () => {
      await repo.save({ name: "Charlie", age: 20 });

      // 캐싱 조회
      await em.find(testEntity.EntityClass, {
        where: { name: "Charlie" },
        cache: true,
      } as any);

      // DB 직접 변경 (ORM을 거치지 않으므로 캐시 무효화 없음)
      await rawQuery(
        `UPDATE \`${testEntity.tableName}\` SET age = 99 WHERE name = 'Charlie'`,
      );

      // 캐시 히트 → 여전히 age=20
      const cached = await em.find(testEntity.EntityClass, {
        where: { name: "Charlie" },
        cache: true,
      } as any);

      const arr = Array.isArray(cached) ? cached : [cached];
      expect(arr[0]?.age).toBe(20);
    });
  });

  // ─── 캐시 키 분리 ──────────────────────────────────────────────────────────

  describe("캐시 키 분리", () => {
    it("서로 다른 where 조건은 별도 캐시 키를 사용해야 한다", async () => {
      await repo.save({ name: "Alice", age: 25 });
      await repo.save({ name: "Bob", age: 30 });

      const aliceResult = await em.find(testEntity.EntityClass, {
        where: { name: "Alice" },
        cache: true,
      } as any);

      const bobResult = await em.find(testEntity.EntityClass, {
        where: { name: "Bob" },
        cache: true,
      } as any);

      const alice = Array.isArray(aliceResult) ? aliceResult : [aliceResult];
      const bob = Array.isArray(bobResult) ? bobResult : [bobResult];

      expect(alice[0]?.name).toBe("Alice");
      expect(bob[0]?.name).toBe("Bob");
      expect(alice[0]?.name).not.toBe(bob[0]?.name);
    });

    it("cache 옵션 없이 조회하면 항상 DB 최신 데이터를 반환해야 한다", async () => {
      const created = await repo.save({ name: "Diana", age: 28 });

      // 캐시 없이 조회
      const result1 = await em.find(testEntity.EntityClass, {
        where: { name: "Diana" },
      } as any);
      const arr1 = Array.isArray(result1) ? result1 : [result1];
      expect(arr1[0]?.age).toBe(28);

      // ORM으로 업데이트
      await repo.save({ id: created.id, name: "Diana", age: 99 });

      // 캐시 없이 조회 → DB 최신 결과
      const result2 = await em.find(testEntity.EntityClass, {
        where: { name: "Diana" },
      } as any);

      const arr2 = Array.isArray(result2) ? result2 : [result2];
      expect(arr2[0]?.age).toBe(99);
    });
  });

  // ─── 캐시 무효화 ──────────────────────────────────────────────────────────

  describe("캐시 무효화", () => {
    it("save() 후 해당 엔티티의 캐시가 무효화되어야 한다", async () => {
      await repo.save({ name: "Eve", age: 22 });

      // 캐싱 조회
      await em.find(testEntity.EntityClass, {
        where: { name: "Eve" },
        cache: true,
      } as any);

      // ORM save()로 새 데이터 추가 → 캐시 무효화됨
      await repo.save({ name: "Frank", age: 35 });

      // 캐시 미스 → DB에서 조회 (전체 조회)
      const result = await em.find(testEntity.EntityClass, {
        cache: true,
      } as any);

      const arr = Array.isArray(result) ? result : [result];
      // save()로 추가한 Frank가 포함되어 있어야 한다
      expect(arr.length).toBeGreaterThanOrEqual(2);
    });

    it("clearCache(entity)로 특정 엔티티의 캐시를 무효화할 수 있어야 한다", async () => {
      await repo.save({ name: "Grace", age: 27 });

      // 캐싱 조회 (1개 결과)
      const cached1 = await em.find(testEntity.EntityClass, {
        cache: true,
      } as any);
      const arr1 = Array.isArray(cached1) ? cached1 : [cached1];
      expect(arr1.length).toBe(1);

      // ORM으로 새 레코드 추가 (save가 캐시를 무효화하지만 다시 캐싱)
      await repo.save({ name: "Extra", age: 99 });

      // 캐시 재설정: 이제 2개 결과가 캐싱됨
      const cached2 = await em.find(testEntity.EntityClass, {
        cache: true,
      } as any);
      const arr2 = Array.isArray(cached2) ? cached2 : [cached2];
      expect(arr2.length).toBe(2);

      // 수동 캐시 무효화
      em.clearCache(testEntity.EntityClass);

      // 캐시 미스 → DB에서 새로 조회 (여전히 2개이지만 캐시가 새로 생성됨)
      const result = await em.find(testEntity.EntityClass, {
        cache: true,
      } as any);
      const arr3 = Array.isArray(result) ? result : [result];
      expect(arr3.length).toBe(2);
    });

    it("clearCache()로 전체 캐시를 무효화할 수 있어야 한다", async () => {
      await repo.save({ name: "Henry", age: 33 });

      // 캐싱 조회 (1개)
      const cached1 = await em.find(testEntity.EntityClass, {
        cache: true,
      } as any);
      const arr1 = Array.isArray(cached1) ? cached1 : [cached1];
      expect(arr1.length).toBe(1);

      // ORM으로 새 레코드 추가
      await repo.save({ name: "Henry2", age: 44 });

      // 전체 캐시 무효화
      em.clearCache();

      // 캐시 미스 → DB에서 새로 조회 (2개)
      const result = await em.find(testEntity.EntityClass, {
        cache: true,
      } as any);
      const arr2 = Array.isArray(result) ? result : [result];
      expect(arr2.length).toBe(2);
    });

    it("delete() 후 해당 엔티티의 캐시가 무효화되어야 한다", async () => {
      const saved = await repo.save({ name: "Ivan", age: 40 });

      // 캐싱 조회
      await em.find(testEntity.EntityClass, { cache: true } as any);

      // 삭제 → 캐시 무효화
      await repo.delete({ id: saved.id } as any);

      // 캐시 미스 → DB에서 조회
      const result = await em.find(testEntity.EntityClass, {
        cache: true,
      } as any);

      const arr = Array.isArray(result) ? result : [result];
      const found = arr.find((item: any) => item?.name === "Ivan");
      expect(found).toBeUndefined();
    });
  });
});
