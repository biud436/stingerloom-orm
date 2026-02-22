/**
 * 생명주기 훅 통합 테스트
 *
 * @BeforeInsert, @AfterInsert, @BeforeUpdate, @AfterUpdate 데코레이터의
 * 실제 DB 연동 동작을 검증합니다.
 *
 * 훅은 `item[methodName]()` 형태로 호출되므로, 엔티티 인스턴스(prototype chain)를
 * 사용하여 save()에 전달해야 합니다. 단순 plain object 리터럴은 불가합니다.
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
import { generateTableName } from "./helpers/create-test-entity";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  HOOK_TOKEN,
  HookMetadata,
} from "../../src";
import Container from "typedi";
import { ColumnScanner } from "../../src/scanner";

// ─────────────────────────────────────────────────────────────────────────────
// 훅 호출 추적용 전역 배열
// ─────────────────────────────────────────────────────────────────────────────

let hookCalls: string[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// 동적 엔티티 팩토리: 생명주기 훅 포함
// ─────────────────────────────────────────────────────────────────────────────

interface HookEntityResult {
  EntityClass: new () => any;
  tableName: string;
}

function createHookTestEntity(baseName = "hook_test"): HookEntityResult {
  const tableName = generateTableName(baseName);

  const DynamicClass = class {
    onBeforeInsert() {
      hookCalls.push("beforeInsert");
      // 훅에서 데이터 변경 테스트: name에 prefix 추가
      if (!(this as any).name?.startsWith("[HOOK]")) {
        (this as any).name = `[HOOK]${(this as any).name}`;
      }
    }

    onAfterInsert() {
      hookCalls.push("afterInsert");
    }

    onBeforeUpdate() {
      hookCalls.push("beforeUpdate");
    }

    onAfterUpdate() {
      hookCalls.push("afterUpdate");
    }
  } as any;

  Object.defineProperty(DynamicClass, "name", {
    value: tableName,
    writable: false,
  });

  const columnScanner = Container.get(ColumnScanner);
  columnScanner.clear();

  // id (PK)
  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "id");
  PrimaryGeneratedColumn()(DynamicClass.prototype, "id");

  // name (VARCHAR)
  Reflect.defineMetadata(
    "design:type",
    String,
    DynamicClass.prototype,
    "name",
  );
  Column()(DynamicClass.prototype, "name");

  // age (INT)
  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "age");
  Column({ type: "int" })(DynamicClass.prototype, "age");

  // HOOK_TOKEN 메타데이터 수동 등록
  const hooks: HookMetadata[] = [
    { methodName: "onBeforeInsert", event: "beforeInsert" },
    { methodName: "onAfterInsert", event: "afterInsert" },
    { methodName: "onBeforeUpdate", event: "beforeUpdate" },
    { methodName: "onAfterUpdate", event: "afterUpdate" },
  ];
  Reflect.defineMetadata(HOOK_TOKEN, hooks, DynamicClass);

  Entity()(DynamicClass);

  return { EntityClass: DynamicClass, tableName };
}

/**
 * DynamicClass의 prototype chain을 가진 엔티티 인스턴스를 생성합니다.
 * runHooks()가 item[methodName]을 호출하려면 prototype에 메서드가 있어야 합니다.
 */
function createInstance(
  EntityClass: new () => any,
  data: Record<string, any>,
): any {
  const instance = Object.create(EntityClass.prototype);
  Object.assign(instance, data);
  return instance;
}

// ─────────────────────────────────────────────────────────────────────────────
// 테스트 스위트
// ─────────────────────────────────────────────────────────────────────────────

describe("[Integration] 생명주기 훅 (@BeforeInsert/@AfterInsert/@BeforeUpdate/@AfterUpdate)", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: HookEntityResult;
  let repo: BaseRepository<any>;

  beforeAll(async () => {
    conn = await createTestConnection(
      { synchronize: true, logging: false },
      () => {
        testEntity = createHookTestEntity();
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
    hookCalls = [];
  });

  // 편의 함수: EntityClass 인스턴스 생성
  function inst(data: Record<string, any>) {
    return createInstance(testEntity.EntityClass, data);
  }

  // ─── @BeforeInsert / @AfterInsert ─────────────────────────────────────────

  describe("INSERT 훅", () => {
    it("새 엔티티 save() 시 @BeforeInsert와 @AfterInsert가 호출되어야 한다", async () => {
      await repo.save(inst({ name: "Alice", age: 25 }));

      expect(hookCalls).toContain("beforeInsert");
      expect(hookCalls).toContain("afterInsert");
    });

    it("@BeforeInsert가 @AfterInsert보다 먼저 호출되어야 한다", async () => {
      await repo.save(inst({ name: "Bob", age: 30 }));

      const beforeIdx = hookCalls.indexOf("beforeInsert");
      const afterIdx = hookCalls.indexOf("afterInsert");

      expect(beforeIdx).toBeGreaterThanOrEqual(0);
      expect(afterIdx).toBeGreaterThanOrEqual(0);
      expect(beforeIdx).toBeLessThan(afterIdx);
    });

    it("@BeforeInsert 훅이 item 객체를 변경할 수 있어야 한다", async () => {
      const instance = inst({ name: "Charlie", age: 35 });
      await repo.save(instance);

      // onBeforeInsert에서 instance.name에 "[HOOK]" prefix를 추가하므로
      // item 객체가 실제로 변경되었는지 확인 (메모리 상)
      expect(instance.name).toBe("[HOOK]Charlie");
      expect(hookCalls).toContain("beforeInsert");
    });
  });

  // ─── @BeforeUpdate / @AfterUpdate ─────────────────────────────────────────

  describe("UPDATE 훅", () => {
    it("기존 엔티티 save(with PK) 시 @BeforeUpdate와 @AfterUpdate가 호출되어야 한다", async () => {
      const created = await repo.save(inst({ name: "Diana", age: 28 }));
      hookCalls = []; // INSERT 훅 기록 초기화

      await repo.save(
        inst({
          id: created.id,
          name: "[HOOK]Diana Updated",
          age: 29,
        }),
      );

      expect(hookCalls).toContain("beforeUpdate");
      expect(hookCalls).toContain("afterUpdate");
    });

    it("@BeforeUpdate가 @AfterUpdate보다 먼저 호출되어야 한다", async () => {
      const created = await repo.save(inst({ name: "Eve", age: 22 }));
      hookCalls = [];

      await repo.save(
        inst({
          id: created.id,
          name: "[HOOK]Eve Modified",
          age: 23,
        }),
      );

      const beforeIdx = hookCalls.indexOf("beforeUpdate");
      const afterIdx = hookCalls.indexOf("afterUpdate");

      expect(beforeIdx).toBeGreaterThanOrEqual(0);
      expect(afterIdx).toBeGreaterThanOrEqual(0);
      expect(beforeIdx).toBeLessThan(afterIdx);
    });

    it("UPDATE 시 INSERT 훅은 호출되지 않아야 한다", async () => {
      const created = await repo.save(inst({ name: "Frank", age: 40 }));
      hookCalls = [];

      await repo.save(
        inst({
          id: created.id,
          name: "[HOOK]Frank Updated",
          age: 41,
        }),
      );

      expect(hookCalls).not.toContain("beforeInsert");
      expect(hookCalls).not.toContain("afterInsert");
    });
  });

  // ─── 전체 라이프사이클 ────────────────────────────────────────────────────

  describe("전체 라이프사이클 훅 순서", () => {
    it("CREATE → UPDATE 시 모든 훅이 올바른 순서로 호출되어야 한다", async () => {
      // CREATE
      const created = await repo.save(inst({ name: "Lifecycle", age: 25 }));
      expect(hookCalls).toEqual(["beforeInsert", "afterInsert"]);

      hookCalls = [];

      // UPDATE
      await repo.save(
        inst({
          id: created.id,
          name: "[HOOK]Lifecycle Updated",
          age: 26,
        }),
      );
      expect(hookCalls).toEqual(["beforeUpdate", "afterUpdate"]);
    });

    it("여러 INSERT가 각각 훅을 호출해야 한다", async () => {
      await repo.save(inst({ name: "User1", age: 10 }));
      await repo.save(inst({ name: "User2", age: 20 }));

      // 2번의 INSERT, 각각 before/after
      const beforeCount = hookCalls.filter(
        (h) => h === "beforeInsert",
      ).length;
      const afterCount = hookCalls.filter((h) => h === "afterInsert").length;

      expect(beforeCount).toBe(2);
      expect(afterCount).toBe(2);
    });
  });
});
