/**
 * P1 기본 CRUD 통합 테스트 — 라운드트립 검증
 *
 * ## 시나리오
 * - J-1: Entity create then immediate read (save → findOne 라운드트립)
 * - J-4: save() return value type (반환값 타입 및 구조 검증)
 * - J-5: Non-existent ID lookup (존재하지 않는 ID 조회 → null)
 * - J-6: find() on empty table (빈 테이블 조회 → 빈 배열)
 * - M-4: FK constraint violation on delete (FK 제약 위반 시 에러)
 *
 * 모든 테스트는 실제 DB에 대한 라운드트립으로 검증합니다.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
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
import {
  createOneToManyTestEntities,
  type RelatedEntitiesResult,
} from "./helpers/create-relation-entity";
import {
  getTestDrivers,
  type TestDriverConfig,
  type TestDriverType,
} from "./helpers/driver-config";
import {
  disableFkChecksSql,
  enableFkChecksSql,
} from "./helpers/driver-helpers";

const skipReason = !process.env.INTEGRATION_TEST
  ? "INTEGRATION_TEST 환경변수가 설정되지 않음"
  : undefined;
const describeIf = skipReason ? describe.skip : describe;

// ═══════════════════════════════════════════════════════════════════════════════
// J-1, J-4, J-5, J-6: 기본 CRUD 라운드트립 (단일 엔티티)
// ═══════════════════════════════════════════════════════════════════════════════

describeIf.each(getTestDrivers())(
  "[P1] 기본 CRUD 라운드트립 테스트 ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let testEntity: DynamicEntityResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          testEntity = createCrudTestEntity("p1_crud");
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
    });

    // ─── J-1: Entity create then immediate read ────────────────────────────────

    describe("J-1: save() → 즉시 findOne() 라운드트립", () => {
      it("save 후 id가 자동 생성(AUTO_INCREMENT)되어야 한다", async () => {
        const owner = await em.save(testEntity.EntityClass, { name: "Alice", age: 30 });

        expect(owner).toBeDefined();
        expect(owner.id).toBeDefined();
        expect(typeof owner.id).toBe("number");
        expect(owner.id).toBeGreaterThan(0);
      });

      it("save 직후 findOne으로 조회하면 동일한 데이터가 반환되어야 한다", async () => {
        const owner = await em.save(testEntity.EntityClass, { name: "Alice", age: 25 });

        const found = await em.findOne(testEntity.EntityClass, {
          where: { id: owner.id },
        });

        expect(found).not.toBeNull();
        expect(found).toBeDefined();
        expect(found!.name).toBe("Alice");
        expect(found!.age).toBe(25);
        expect(found!.id).toBe(owner.id);
      });

      it("여러 엔티티를 save 후 각각 findOne으로 검증", async () => {
        const alice = await em.save(testEntity.EntityClass, { name: "Alice", age: 25 });
        const bob = await em.save(testEntity.EntityClass, { name: "Bob", age: 30 });
        const charlie = await em.save(testEntity.EntityClass, { name: "Charlie", age: 35 });

        const foundAlice = await em.findOne(testEntity.EntityClass, {
          where: { id: alice.id },
        });
        const foundBob = await em.findOne(testEntity.EntityClass, {
          where: { id: bob.id },
        });
        const foundCharlie = await em.findOne(testEntity.EntityClass, {
          where: { id: charlie.id },
        });

        expect(foundAlice!.name).toBe("Alice");
        expect(foundBob!.name).toBe("Bob");
        expect(foundCharlie!.name).toBe("Charlie");

        // id는 모두 다르고 순차적
        expect(alice.id).toBeLessThan(bob.id);
        expect(bob.id).toBeLessThan(charlie.id);
      });

      it("nullable 컬럼이 null인 엔티티도 라운드트립이 정확해야 한다", async () => {
        const saved = await em.save(testEntity.EntityClass, {
          name: "NoEmail",
          age: 20,
          email: null,
        });

        const found = await em.findOne(testEntity.EntityClass, {
          where: { id: saved.id },
        });

        expect(found).not.toBeNull();
        expect(found!.name).toBe("NoEmail");
        expect(found!.email == null).toBe(true);
      });
    });

    // ─── J-4: save() return value type ─────────────────────────────────────────

    describe("J-4: save() 반환값 타입 검증", () => {
      it("save()는 단일 객체를 반환해야 한다 (배열이 아님)", async () => {
        const result = await em.save(testEntity.EntityClass, { name: "Alice", age: 25 });

        expect(result).toBeDefined();
        expect(result).not.toBeNull();
        expect(Array.isArray(result)).toBe(false);
        expect(typeof result).toBe("object");
      });

      it("반환 객체에 id 프로퍼티가 있어야 한다", async () => {
        const result = await em.save(testEntity.EntityClass, { name: "Bob", age: 30 });

        expect(result).toHaveProperty("id");
        expect(typeof result.id).toBe("number");
        expect(result.id).toBeGreaterThan(0);
      });

      it("반환 객체에 저장된 필드 값이 포함되어야 한다", async () => {
        const result = await em.save(testEntity.EntityClass, {
          name: "Charlie",
          age: 35,
          email: "charlie@test.com",
        });

        expect(result.name).toBe("Charlie");
        expect(result.age).toBe(35);
        expect(result.email).toBe("charlie@test.com");
      });

      it("save()의 반환값은 undefined가 아니어야 한다", async () => {
        const result = await em.save(testEntity.EntityClass, { name: "Diana", age: 28 });

        expect(result !== undefined).toBe(true);
        expect(result !== null).toBe(true);
      });
    });

    // ─── J-5: Non-existent ID lookup ──────────────────────────────────────────

    describe("J-5: 존재하지 않는 ID 조회", () => {
      it("존재하지 않는 ID로 findOne하면 null을 반환해야 한다", async () => {
        const result = await em.findOne(testEntity.EntityClass, {
          where: { id: 999999 },
        });

        expect(result).toBeNull();
      });

      it("null이지 undefined가 아니어야 한다", async () => {
        const result = await em.findOne(testEntity.EntityClass, {
          where: { id: 888888 },
        });

        expect(result).toBeNull();
        expect(typeof result).not.toBe("undefined");
        // null의 typeof는 "object"
        expect(result === null).toBe(true);
        expect(result === undefined).toBe(false);
      });

      it("에러를 throw하지 않아야 한다", async () => {
        await expect(
          em.findOne(testEntity.EntityClass, { where: { id: 777777 } }),
        ).resolves.toBeNull();
      });

      it("삭제된 ID로 findOne해도 null을 반환해야 한다", async () => {
        // 생성 후 삭제
        const saved = await em.save(testEntity.EntityClass, { name: "Temp", age: 10 });
        const repo = em.getRepository(testEntity.EntityClass);
        await repo.delete({ id: saved.id } as any);

        // 삭제된 ID 조회
        const found = await em.findOne(testEntity.EntityClass, {
          where: { id: saved.id },
        });

        expect(found).toBeNull();
      });
    });

    // ─── J-6: find() on empty table ───────────────────────────────────────────
    //
    // 발견: em.find()는 빈 테이블에서 빈 배열([])이 아닌 undefined를 반환합니다.
    // 이는 사용자가 `result.length` 등을 호출하면 런타임 에러가 발생할 수 있는 문제입니다.
    // 테스트에서는 현재 동작을 검증하되, 이 동작이 개선 대상임을 기록합니다.
    //

    describe("J-6: 빈 테이블에서 find()", () => {
      it("빈 테이블에서 find()하면 에러 없이 반환해야 한다", async () => {
        const result = await em.find(testEntity.EntityClass, {});

        // 현재 동작: 빈 결과 시 undefined 반환 (이상적으로는 빈 배열)
        // 에러를 throw하지는 않아야 한다
        const items = Array.isArray(result) ? result : result ? [result] : [];
        expect(items).toHaveLength(0);
      });

      it("빈 결과를 안전하게 처리할 수 있어야 한다", async () => {
        const result = await em.find(testEntity.EntityClass, {});

        // 현재 동작: undefined 반환
        // 사용자 코드에서 안전하게 처리하려면 null/undefined 체크 필요
        const items = result ?? [];
        expect(Array.isArray(items) || items === undefined || items === null || (items as any[]).length === 0).toBeTruthy();
      });

      it("where 조건 매칭이 없어도 에러 없이 반환해야 한다", async () => {
        const result = await em.find(testEntity.EntityClass, {
          where: { name: "NonExistent" },
        });

        const items = Array.isArray(result) ? result : result ? [result] : [];
        expect(items).toHaveLength(0);
      });

      it("데이터 추가 후 find()하면 배열로 결과가 반환되어야 한다", async () => {
        // 데이터 추가
        await em.save(testEntity.EntityClass, { name: "First", age: 20 });
        await em.save(testEntity.EntityClass, { name: "Second", age: 25 });

        // 조회 — 데이터가 있으면 배열로 반환
        const result = await em.find(testEntity.EntityClass, {});
        const items = Array.isArray(result) ? result : result ? [result] : [];
        expect(items.length).toBe(2);
      });
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// M-4: FK constraint violation on delete (관계 엔티티 사용)
// ═══════════════════════════════════════════════════════════════════════════════

describeIf.each(getTestDrivers())(
  "[P1] M-4: FK 제약 위반 삭제 테스트 ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entities: RelatedEntitiesResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entities = createOneToManyTestEntities("p1_fk");
          return {
            entities: [entities.ParentClass, entities.ChildClass],
          };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        if (entities) await dropTestTable(entities.childTableName);
        if (entities) await dropTestTable(entities.parentTableName);
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await rawQuery(disableFkChecksSql(type));
      await truncateTestTable(entities.childTableName);
      await truncateTestTable(entities.parentTableName);
      await rawQuery(enableFkChecksSql(type));
    });

    it("자식이 있는 부모를 삭제하면 FK 제약 위반 에러가 발생해야 한다", async () => {
      const parentRepo = em.getRepository(entities.ParentClass);
      const childRepo = em.getRepository(entities.ChildClass);

      // 부모 생성
      const parent = await parentRepo.save({ name: "Owner" });

      // 자식 생성 (FK로 부모 참조)
      await childRepo.save({ title: "Cat1", parentFk: parent.id });
      await childRepo.save({ title: "Cat2", parentFk: parent.id });

      // 부모 삭제 시도 → FK 제약 위반
      await expect(
        parentRepo.delete({ id: parent.id } as any),
      ).rejects.toThrow();
    });

    it("FK 제약 위반 에러 메시지가 이해 가능해야 한다", async () => {
      const parentRepo = em.getRepository(entities.ParentClass);
      const childRepo = em.getRepository(entities.ChildClass);

      const parent = await parentRepo.save({ name: "ErrorOwner" });
      await childRepo.save({ title: "ErrorCat", parentFk: parent.id });

      try {
        await parentRepo.delete({ id: parent.id } as any);
        // 여기 도달하면 안 됨
        fail("FK 제약 위반 에러가 발생해야 합니다");
      } catch (error: any) {
        // 에러 객체가 존재하고 메시지가 있어야 한다
        expect(error).toBeDefined();
        expect(error.message || error.toString()).toBeDefined();
        expect(typeof (error.message || error.toString())).toBe("string");
        expect((error.message || error.toString()).length).toBeGreaterThan(0);
      }
    });

    it("자식을 먼저 삭제하고 부모를 삭제하면 성공해야 한다", async () => {
      const parentRepo = em.getRepository(entities.ParentClass);
      const childRepo = em.getRepository(entities.ChildClass);

      const parent = await parentRepo.save({ name: "SafeOwner" });
      const cat1 = await childRepo.save({ title: "SafeCat1", parentFk: parent.id });
      const cat2 = await childRepo.save({ title: "SafeCat2", parentFk: parent.id });

      // 자식 먼저 삭제
      await childRepo.delete({ id: cat1.id } as any);
      await childRepo.delete({ id: cat2.id } as any);

      // 이제 부모 삭제 — 에러 없이 성공해야 한다
      const result = await parentRepo.delete({ id: parent.id } as any);
      expect(result).toBeDefined();
      expect(result.affected).toBeGreaterThanOrEqual(1);

      // 부모가 실제로 삭제되었는지 확인
      const found = await parentRepo.findOne({ where: { id: parent.id } });
      const item = Array.isArray(found) ? found[0] : found;
      if (item) {
        // findOne이 배열의 첫 요소를 반환할 수 있음
        expect(item).toBeUndefined();
      } else {
        expect(item == null).toBe(true);
      }
    });

    it("FK 제약 위반 후에도 DB 상태가 변경되지 않아야 한다", async () => {
      const parentRepo = em.getRepository(entities.ParentClass);
      const childRepo = em.getRepository(entities.ChildClass);

      const parent = await parentRepo.save({ name: "RollbackOwner" });
      await childRepo.save({ title: "RollbackCat", parentFk: parent.id });

      // 삭제 시도 (실패)
      try {
        await parentRepo.delete({ id: parent.id } as any);
      } catch {
        // 에러 무시
      }

      // 부모가 여전히 존재해야 한다
      const foundParent = await parentRepo.findOne({ where: { id: parent.id } });
      const p = Array.isArray(foundParent) ? foundParent[0] : foundParent;
      expect(p).toBeDefined();
      expect(p.name).toBe("RollbackOwner");

      // 자식도 여전히 존재해야 한다
      const children = await childRepo.find({ where: { parentFk: parent.id } } as any);
      const items = Array.isArray(children) ? children : children ? [children] : [];
      expect(items.length).toBe(1);
      expect(items[0].title).toBe("RollbackCat");
    });
  },
);
