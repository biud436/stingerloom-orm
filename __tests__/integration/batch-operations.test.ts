/**
 * 배치 연산 통합 테스트
 *
 * EntityManager와 BaseRepository의 배치 연산을 검증합니다.
 * - insertMany(): 단일 INSERT 쿼리로 여러 엔티티 삽입
 * - saveMany(): 여러 엔티티 개별 저장 (INSERT/UPDATE 자동 판별)
 * - deleteMany(): PK 배열로 여러 엔티티 일괄 삭제
 *
 * 실행 전 필요 사항:
 * - MySQL/PostgreSQL 서버 실행 중
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
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  createCrudTestEntity,
  DynamicEntityResult,
} from "./helpers/create-test-entity";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const drivers = getTestDrivers();

describe("[Integration] 배치 연산 (insertMany/saveMany/deleteMany)", () => {
  describe.each(drivers)("$label", ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let testEntity: DynamicEntityResult;
    let repo: BaseRepository<any>;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          testEntity = createCrudTestEntity("batch_test");
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

    // ─── insertMany ───────────────────────────────────────────────────────────

    describe("insertMany()", () => {
      it("여러 엔티티를 한 번에 삽입할 수 있어야 한다", async () => {
        const result = await repo.insertMany([
          { name: "Alice", age: 25 },
          { name: "Bob", age: 30 },
          { name: "Charlie", age: 35 },
        ]);

        expect(result).toBeDefined();
        expect(result.affected).toBe(3);
      });

      it("insertMany 후 find()로 삽입된 레코드를 조회할 수 있어야 한다", async () => {
        await repo.insertMany([
          { name: "D1", age: 10 },
          { name: "D2", age: 20 },
        ]);

        const found = await repo.find();
        const items = Array.isArray(found) ? found : found ? [found] : [];

        expect(items.length).toBe(2);
        const names = items.map((i: any) => i.name).sort();
        expect(names).toEqual(["D1", "D2"]);
      });

      it("빈 배열을 insertMany하면 affected가 0이어야 한다", async () => {
        const result = await repo.insertMany([]);
        expect(result.affected).toBe(0);
      });

      it("insertMany 후 count()가 정확해야 한다", async () => {
        await repo.insertMany([
          { name: "A", age: 1 },
          { name: "B", age: 2 },
          { name: "C", age: 3 },
          { name: "D", age: 4 },
          { name: "E", age: 5 },
        ]);

        const count = await repo.count();
        expect(count).toBe(5);
      });

      it("nullable 컬럼은 null로 삽입할 수 있어야 한다", async () => {
        await repo.insertMany([
          { name: "NullEmail1", age: 10, email: null },
          { name: "NullEmail2", age: 20, email: null },
        ]);

        const found = await repo.find();
        const items = Array.isArray(found) ? found : found ? [found] : [];

        for (const item of items) {
          expect(item.email == null).toBe(true);
        }
      });
    });

    // ─── saveMany ─────────────────────────────────────────────────────────────

    describe("saveMany()", () => {
      it("여러 새 엔티티를 저장하면 각각 id가 생성되어야 한다", async () => {
        const results = await repo.saveMany([
          { name: "S1", age: 10 },
          { name: "S2", age: 20 },
          { name: "S3", age: 30 },
        ]);

        expect(results).toBeDefined();
        expect(results.length).toBe(3);

        for (const item of results) {
          expect(item.id).toBeDefined();
          expect(item.id).toBeGreaterThan(0);
        }
      });

      it("saveMany로 저장된 엔티티의 필드 값이 정확해야 한다", async () => {
        const results = await repo.saveMany([
          { name: "Alice", age: 25, email: "alice@test.com" },
          { name: "Bob", age: 30, email: "bob@test.com" },
        ]);

        expect(results[0].name).toBe("Alice");
        expect(results[0].age).toBe(25);
        expect(results[1].name).toBe("Bob");
        expect(results[1].age).toBe(30);
      });

      it("빈 배열을 saveMany하면 빈 배열이 반환되어야 한다", async () => {
        const results = await repo.saveMany([]);
        expect(results).toEqual([]);
      });

      it("PK가 포함된 엔티티는 UPDATE로 처리되어야 한다", async () => {
        // 먼저 INSERT
        const created = await repo.save({ name: "Original", age: 10 });

        // saveMany로 UPDATE (PK 포함)
        const results = await repo.saveMany([
          { id: created.id, name: "Updated", age: 11 },
        ]);

        expect(results.length).toBe(1);

        // DB에서 확인
        const found = await repo.findOne({
          where: { id: created.id },
        });
        const item = Array.isArray(found) ? found[0] : found;
        expect(item.name).toBe("Updated");
        expect(item.age).toBe(11);
      });

      it("INSERT와 UPDATE가 혼합된 saveMany가 정상 동작해야 한다", async () => {
        const existing = await repo.save({ name: "Existing", age: 100 });

        const results = await repo.saveMany([
          { id: existing.id, name: "Existing Updated", age: 101 },
          { name: "NewEntity", age: 200 },
        ]);

        expect(results.length).toBe(2);

        const count = await repo.count();
        expect(count).toBe(2);
      });
    });

    // ─── deleteMany ───────────────────────────────────────────────────────────

    describe("deleteMany()", () => {
      it("PK 배열로 여러 엔티티를 한 번에 삭제할 수 있어야 한다", async () => {
        const s1 = await repo.save({ name: "A", age: 10 });
        const s2 = await repo.save({ name: "B", age: 20 });
        await repo.save({ name: "C", age: 30 });

        const result = await repo.deleteMany([s1.id, s2.id]);

        expect(result).toBeDefined();
        expect(result.affected).toBe(2);
      });

      it("deleteMany 후 남은 레코드만 조회되어야 한다", async () => {
        const s1 = await repo.save({ name: "Delete1", age: 10 });
        const s2 = await repo.save({ name: "Delete2", age: 20 });
        const s3 = await repo.save({ name: "Keep", age: 30 });

        await repo.deleteMany([s1.id, s2.id]);

        const found = await repo.find();
        const items = Array.isArray(found) ? found : found ? [found] : [];

        expect(items.length).toBe(1);
        expect(items[0].name).toBe("Keep");
      });

      it("빈 배열을 deleteMany하면 affected가 0이어야 한다", async () => {
        await repo.save({ name: "Safe", age: 10 });

        const result = await repo.deleteMany([]);
        expect(result.affected).toBe(0);

        // 기존 레코드가 유지되는지 확인
        const count = await repo.count();
        expect(count).toBe(1);
      });

      it("존재하지 않는 PK를 포함해도 에러 없이 처리되어야 한다", async () => {
        const s1 = await repo.save({ name: "Real", age: 10 });

        const result = await repo.deleteMany([s1.id, 99999]);
        expect(result.affected).toBe(1);

        const count = await repo.count();
        expect(count).toBe(0);
      });
    });

    // ─── 복합 시나리오 ────────────────────────────────────────────────────────

    describe("복합 배치 시나리오", () => {
      it("insertMany -> find -> deleteMany 전체 흐름", async () => {
        // 1. 배치 삽입
        const insertResult = await repo.insertMany([
          { name: "Batch1", age: 10 },
          { name: "Batch2", age: 20 },
          { name: "Batch3", age: 30 },
        ]);
        expect(insertResult.affected).toBe(3);

        // 2. 전체 조회
        const found = await repo.find();
        const items = Array.isArray(found) ? found : found ? [found] : [];
        expect(items.length).toBe(3);

        // 3. 전체 삭제
        const ids = items.map((i: any) => i.id);
        const deleteResult = await repo.deleteMany(ids);
        expect(deleteResult.affected).toBe(3);

        // 4. 비어있음 확인
        const count = await repo.count();
        expect(count).toBe(0);
      });

      it("saveMany로 대량 데이터 저장 후 집계 확인", async () => {
        const items = Array.from({ length: 10 }, (_, i) => ({
          name: `User${i + 1}`,
          age: (i + 1) * 5,
        }));

        const results = await repo.saveMany(items);
        expect(results.length).toBe(10);

        const count = await repo.count();
        expect(count).toBe(10);

        const sum = await repo.sum("age");
        // 5+10+15+20+25+30+35+40+45+50 = 275
        expect(sum).toBe(275);
      });
    });
  });
});
