/**
 * 기본 CRUD 통합 테스트
 *
 * 실제 MySQL 데이터베이스에 연결하여 EntityManager와 BaseRepository의
 * Create, Read, Update, Delete 전체 사이클을 검증합니다.
 *
 * 테이블명에 타임스탬프를 포함하여 다른 테스트와의 충돌을 방지합니다.
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

describe("[Integration] 기본 CRUD 테스트", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: DynamicEntityResult;
  let repo: BaseRepository<any>;

  beforeAll(async () => {
    // entityFactory 패턴: 메타데이터 리셋 → 엔티티 생성 → 연결
    // 이렇게 해야 MetadataLayerRegistry.reset() 이후에 엔티티가 등록됩니다.
    conn = await createTestConnection(
      { synchronize: true, logging: false },
      () => {
        testEntity = createCrudTestEntity();
        return { entities: [testEntity.EntityClass] };
      },
    );
    em = conn.em;

    // 리포지토리 생성
    repo = em.getRepository(testEntity.EntityClass);
  }, 30000); // DB 연결 타임아웃 고려

  afterAll(async () => {
    // 테스트 테이블 정리
    try {
      await dropTestTable(testEntity.tableName);
    } catch {
      // ignore
    }
    await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    // 각 테스트 전에 데이터 초기화
    await truncateTestTable(testEntity.tableName);
  });

  // ─────────────────────────────────────────────────────────
  // CREATE
  // ─────────────────────────────────────────────────────────

  describe("Create (save)", () => {
    it("새 엔티티를 저장하면 id가 자동 생성되어야 한다", async () => {
      const saved = await repo.save({
        name: "Alice",
        age: 25,
        email: "alice@test.com",
      });

      expect(saved).toBeDefined();
      expect(saved.id).toBeDefined();
      expect(typeof saved.id).toBe("number");
      expect(saved.id).toBeGreaterThan(0);
    });

    it("저장된 엔티티의 필드 값이 정확해야 한다", async () => {
      const saved = await repo.save({
        name: "Bob",
        age: 30,
        email: "bob@test.com",
      });

      expect(saved.name).toBe("Bob");
      expect(saved.age).toBe(30);
      expect(saved.email).toBe("bob@test.com");
    });

    it("nullable 컬럼은 null로 저장할 수 있어야 한다", async () => {
      const saved = await repo.save({
        name: "Charlie",
        age: 20,
        email: null,
      });

      expect(saved).toBeDefined();
      expect(saved.id).toBeGreaterThan(0);
      // email이 null이면 null 또는 undefined로 반환
      expect(saved.email == null).toBe(true);
    });

    it("여러 엔티티를 순차적으로 저장하면 서로 다른 id를 가져야 한다", async () => {
      const saved1 = await repo.save({ name: "User1", age: 20 });
      const saved2 = await repo.save({ name: "User2", age: 25 });
      const saved3 = await repo.save({ name: "User3", age: 30 });

      expect(saved1.id).not.toBe(saved2.id);
      expect(saved2.id).not.toBe(saved3.id);
      expect(saved1.id).toBeLessThan(saved2.id);
    });
  });

  // ─────────────────────────────────────────────────────────
  // READ
  // ─────────────────────────────────────────────────────────

  describe("Read (find / findOne)", () => {
    beforeEach(async () => {
      // 테스트 데이터 시딩
      await repo.save({ name: "Alice", age: 25, email: "alice@test.com" });
      await repo.save({ name: "Bob", age: 30, email: "bob@test.com" });
      await repo.save({ name: "Charlie", age: 35, email: null });
    });

    it("find()로 전체 목록을 조회할 수 있어야 한다", async () => {
      const result = await repo.find();
      const items = Array.isArray(result) ? result : [result];

      expect(items.length).toBeGreaterThanOrEqual(3);
    });

    it("findOne()으로 조건에 맞는 단일 엔티티를 조회할 수 있어야 한다", async () => {
      const result = await repo.findOne({ where: { name: "Alice" } });

      // findOne은 단일 객체 또는 배열의 첫 요소를 반환
      const item = Array.isArray(result) ? result[0] : result;

      expect(item).toBeDefined();
      expect(item.name).toBe("Alice");
      expect(item.age).toBe(25);
      expect(item.email).toBe("alice@test.com");
    });

    it("where 조건으로 필터링할 수 있어야 한다", async () => {
      const result = await repo.find({ where: { age: 30 } });
      const items = Array.isArray(result) ? result : result ? [result] : [];

      expect(items.length).toBe(1);
      expect(items[0].name).toBe("Bob");
    });

    it("존재하지 않는 조건으로 findOne하면 결과가 없어야 한다", async () => {
      const result = await repo.findOne({ where: { name: "NonExistent" } });

      // undefined 또는 빈 배열 중 하나
      if (Array.isArray(result)) {
        expect(result.length).toBe(0);
      } else {
        expect(result).toBeUndefined();
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // UPDATE
  // ─────────────────────────────────────────────────────────

  describe("Update (save with PK)", () => {
    it("기존 엔티티의 PK를 포함하여 save하면 UPDATE가 수행되어야 한다", async () => {
      // 1. 생성
      const created = await repo.save({
        name: "Diana",
        age: 28,
        email: "diana@test.com",
      });
      const createdId = created.id;

      // 2. 수정
      const updated = await repo.save({
        id: createdId,
        name: "Diana Updated",
        age: 29,
        email: "diana.new@test.com",
      });

      // 3. 검증 - UPDATE 후 재조회
      const found = await repo.findOne({ where: { id: createdId } as any });
      const item = Array.isArray(found) ? found[0] : found;

      expect(item).toBeDefined();
      expect(item.name).toBe("Diana Updated");
      expect(item.age).toBe(29);
      expect(item.email).toBe("diana.new@test.com");
    });

    it("업데이트 후에도 id가 변하지 않아야 한다", async () => {
      const created = await repo.save({ name: "Eve", age: 22 });
      const originalId = created.id;

      await repo.save({
        id: originalId,
        name: "Eve Modified",
        age: 23,
      });

      const found = await repo.findOne({ where: { id: originalId } as any });
      const item = Array.isArray(found) ? found[0] : found;

      expect(item).toBeDefined();
      expect(item.id).toBe(originalId);
    });
  });

  // ─────────────────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────────────────

  describe("Delete", () => {
    it("delete()로 엔티티를 삭제할 수 있어야 한다", async () => {
      // 1. 생성
      const created = await repo.save({
        name: "Frank",
        age: 40,
        email: "frank@test.com",
      });

      // 2. 삭제
      const deleteResult = await repo.delete({
        id: created.id,
      } as any);

      expect(deleteResult).toBeDefined();
      expect(deleteResult.affected).toBeGreaterThanOrEqual(1);

      // 3. 삭제 확인
      const found = await repo.findOne({
        where: { id: created.id } as any,
      });
      if (Array.isArray(found)) {
        expect(found.length).toBe(0);
      } else {
        expect(found).toBeUndefined();
      }
    });

    it("조건에 맞는 여러 엔티티가 삭제되어야 한다", async () => {
      await repo.save({ name: "Same", age: 50 });
      await repo.save({ name: "Same", age: 50 });
      await repo.save({ name: "Different", age: 60 });

      const deleteResult = await repo.delete({ name: "Same" } as any);
      expect(deleteResult.affected).toBe(2);

      // "Different"는 남아있어야 함
      const remaining = await repo.find({ where: { name: "Different" } });
      const items = Array.isArray(remaining)
        ? remaining
        : remaining
          ? [remaining]
          : [];
      expect(items.length).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────
  // FULL LIFECYCLE
  // ─────────────────────────────────────────────────────────

  describe("전체 CRUD 라이프사이클", () => {
    it("Create → Read → Update → Read → Delete → Read 전체 흐름이 정상 동작해야 한다", async () => {
      // CREATE
      const created = await repo.save({
        name: "Lifecycle User",
        age: 25,
        email: "lifecycle@test.com",
      });
      expect(created.id).toBeDefined();

      // READ (생성 직후)
      let found = await repo.findOne({
        where: { id: created.id } as any,
      });
      let item = Array.isArray(found) ? found[0] : found;
      expect(item).toBeDefined();
      expect(item.name).toBe("Lifecycle User");

      // UPDATE
      await repo.save({
        id: created.id,
        name: "Updated Lifecycle User",
        age: 26,
        email: "updated.lifecycle@test.com",
      });

      // READ (업데이트 후)
      found = await repo.findOne({
        where: { id: created.id } as any,
      });
      item = Array.isArray(found) ? found[0] : found;
      expect(item).toBeDefined();
      expect(item.name).toBe("Updated Lifecycle User");
      expect(item.age).toBe(26);

      // DELETE
      const deleteResult = await repo.delete({
        id: created.id,
      } as any);
      expect(deleteResult.affected).toBe(1);

      // READ (삭제 후)
      found = await repo.findOne({
        where: { id: created.id } as any,
      });
      if (Array.isArray(found)) {
        expect(found.length).toBe(0);
      } else {
        expect(found).toBeUndefined();
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // COUNT / 집계
  // ─────────────────────────────────────────────────────────

  describe("집계 함수", () => {
    beforeEach(async () => {
      await repo.save({ name: "A", age: 10 });
      await repo.save({ name: "B", age: 20 });
      await repo.save({ name: "C", age: 30 });
    });

    it("count()로 전체 개수를 조회할 수 있어야 한다", async () => {
      const count = await repo.count();
      expect(count).toBe(3);
    });

    it("조건부 count()가 정확해야 한다", async () => {
      const count = await repo.count({ name: "A" } as any);
      expect(count).toBe(1);
    });
  });
});
