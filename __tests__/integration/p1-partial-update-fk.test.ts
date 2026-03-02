/**
 * P1 통합 테스트 — M-6: 부분 업데이트 시 FK 보존 검증
 *
 * save({ id, name }) 같은 부분 업데이트가 기존 FK 컬럼 값을 NULL로
 * 초기화하지 않는지 검증합니다.
 *
 * ## 시나리오
 * - M-6a: 부분 업데이트 시 FK 컬럼 보존
 * - M-6b: 부분 업데이트 시 다른 컬럼(age 등) 보존
 * - M-6c: 부분 업데이트에서 FK를 명시적으로 변경
 * - M-6d: 부분 업데이트에서 FK를 명시적으로 null 설정
 *
 * ## 핵심 원칙
 * 모든 테스트는 save() → DB round-trip → rawQuery/findOne()으로 실제 DB 상태를 검증합니다.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
} from "../../src";
import Container from "typedi";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
} from "../../src/scanner";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import {
  qi,
  disableFkChecksSql,
  enableFkChecksSql,
} from "./helpers/driver-helpers";

const skipReason = !process.env.INTEGRATION_TEST
  ? "INTEGRATION_TEST 환경변수가 설정되지 않음"
  : undefined;
const describeIf = skipReason ? describe.skip : describe;

const drivers = getTestDrivers();

/**
 * 부분 업데이트 테스트용 엔티티 생성 (age 컬럼 추가)
 */
function createPartialUpdateEntities() {
  const ts = String(Date.now()).slice(-7);
  const parentTableName = `pu_p_${ts}`;
  const childTableName = `pu_c_${ts}`;

  Container.get(ColumnScanner).clear();
  Container.get(ManyToOneScanner).clear();
  Container.get(OneToManyScanner).clear();

  // ── Parent ──
  const ParentClass = class {} as any;
  Object.defineProperty(ParentClass, "name", {
    value: parentTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ParentClass.prototype, "id");
  PrimaryGeneratedColumn()(ParentClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ParentClass.prototype, "name");
  Column()(ParentClass.prototype, "name");

  Reflect.defineMetadata(
    "design:type",
    Array,
    ParentClass.prototype,
    "children",
  );
  OneToMany(() => ChildClass, { mappedBy: "parent" })(
    ParentClass.prototype,
    "children",
  );

  Entity()(ParentClass);

  // ── Child (id, title, age, parentFk, parent) ──
  const ChildClass = class {} as any;
  Object.defineProperty(ChildClass, "name", {
    value: childTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ChildClass.prototype, "id");
  PrimaryGeneratedColumn()(ChildClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ChildClass.prototype, "title");
  Column()(ChildClass.prototype, "title");

  Reflect.defineMetadata("design:type", Number, ChildClass.prototype, "age");
  Column({ type: "int", nullable: true })(ChildClass.prototype, "age");

  Reflect.defineMetadata(
    "design:type",
    Number,
    ChildClass.prototype,
    "parentFk",
  );
  Column({ type: "int", nullable: true })(ChildClass.prototype, "parentFk");

  Reflect.defineMetadata(
    "design:type",
    ParentClass,
    ChildClass.prototype,
    "parent",
  );
  ManyToOne(() => ParentClass, (e: any) => e.parent, {
    joinColumn: "parentFk",
    eager: true,
  })(ChildClass.prototype, "parent");

  Entity()(ChildClass);

  return { ParentClass, ChildClass, parentTableName, childTableName };
}

describeIf("[P1] M-6: 부분 업데이트 시 FK 보존", () => {
  describe.each(drivers)("$label", ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entities: ReturnType<typeof createPartialUpdateEntities>;
    let parentRepo: BaseRepository<any>;
    let childRepo: BaseRepository<any>;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entities = createPartialUpdateEntities();
          return {
            entities: [entities.ParentClass, entities.ChildClass],
          };
        },
      );
      em = conn.em;
      parentRepo = em.getRepository(entities.ParentClass);
      childRepo = em.getRepository(entities.ChildClass);
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
      await truncateTestTable(entities.childTableName);
      await truncateTestTable(entities.parentTableName);
    });

    // ─── M-6a: 부분 업데이트 시 FK 보존 ─────────────────────────────────────────

    describe("M-6a: 부분 업데이트 시 FK 보존", () => {
      it("save({ id, title }) 시 기존 FK가 NULL로 초기화되지 않아야 한다", async () => {
        const parent = await parentRepo.save({ name: "Owner" });
        const saved = await childRepo.save({
          title: "Nabi",
          age: 3,
          parent: parent,
        });

        // 부분 업데이트: title만 변경 (FK, age 미포함)
        await childRepo.save({
          id: saved.id,
          title: "NewName",
        });

        // DB raw 쿼리로 FK 검증
        const rows = await rawQuery(
          `SELECT parentFk, age, title FROM ${qi(type, entities.childTableName)} WHERE id = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;

        expect(Number(row?.parentFk)).toBe(parent.id);
        expect(row?.title).toBe("NewName");
      });

      it("save({ id, title }) 후 findOne으로 FK 관계가 여전히 로딩되어야 한다", async () => {
        const parent = await parentRepo.save({ name: "Alice" });
        const saved = await childRepo.save({
          title: "Cat1",
          parent: parent,
        });

        // 부분 업데이트
        await childRepo.save({
          id: saved.id,
          title: "UpdatedCat",
        });

        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;

        expect(child.title).toBe("UpdatedCat");
        expect(child.parent).toBeDefined();
        expect(child.parent).not.toBeNull();
        expect(child.parent.id).toBe(parent.id);
        expect(child.parent.name).toBe("Alice");
      });

      it("FK를 직접 지정한 경우에도 부분 업데이트에서 보존되어야 한다", async () => {
        const parent = await parentRepo.save({ name: "Direct FK Owner" });
        const saved = await childRepo.save({
          title: "DirectChild",
          parentFk: parent.id,
        });

        // 부분 업데이트: parentFk 미포함
        await childRepo.save({
          id: saved.id,
          title: "DirectUpdated",
        });

        const rows = await rawQuery(
          `SELECT parentFk FROM ${qi(type, entities.childTableName)} WHERE id = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;

        expect(Number(row?.parentFk)).toBe(parent.id);
      });
    });

    // ─── M-6b: 부분 업데이트 시 다른 컬럼 보존 ─────────────────────────────────

    describe("M-6b: 부분 업데이트 시 다른 컬럼 보존", () => {
      it("save({ id, title }) 시 age가 보존되어야 한다", async () => {
        const saved = await childRepo.save({
          title: "Aged Cat",
          age: 5,
        });

        // 부분 업데이트: title만 변경
        await childRepo.save({
          id: saved.id,
          title: "Still Aged",
        });

        const rows = await rawQuery(
          `SELECT age, title FROM ${qi(type, entities.childTableName)} WHERE id = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;

        expect(Number(row?.age)).toBe(5);
        expect(row?.title).toBe("Still Aged");
      });

      it("save({ id, age }) 시 title이 보존되어야 한다", async () => {
        const saved = await childRepo.save({
          title: "Keep Title",
          age: 2,
        });

        // 부분 업데이트: age만 변경
        await childRepo.save({
          id: saved.id,
          age: 10,
        });

        const rows = await rawQuery(
          `SELECT age, title FROM ${qi(type, entities.childTableName)} WHERE id = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;

        expect(Number(row?.age)).toBe(10);
        expect(row?.title).toBe("Keep Title");
      });

      it("모든 컬럼이 동시에 보존되어야 한다 (FK + age + title)", async () => {
        const parent = await parentRepo.save({ name: "Full Owner" });
        const saved = await childRepo.save({
          title: "Full Cat",
          age: 7,
          parent: parent,
        });

        // id만 지정한 빈 업데이트 (아무 필드도 변경하지 않음)
        await childRepo.save({
          id: saved.id,
        });

        const rows = await rawQuery(
          `SELECT title, age, parentFk FROM ${qi(type, entities.childTableName)} WHERE id = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;

        expect(row?.title).toBe("Full Cat");
        expect(Number(row?.age)).toBe(7);
        expect(Number(row?.parentFk)).toBe(parent.id);
      });
    });

    // ─── M-6c: 부분 업데이트에서 FK 명시적 변경 ────────────────────────────────

    describe("M-6c: 부분 업데이트에서 FK 명시적 변경", () => {
      it("부분 업데이트에서 parent를 다른 객체로 변경할 수 있어야 한다", async () => {
        const parent1 = await parentRepo.save({ name: "Old" });
        const parent2 = await parentRepo.save({ name: "New" });
        const saved = await childRepo.save({
          title: "Switching Cat",
          age: 3,
          parent: parent1,
        });

        // 부분 업데이트: parent만 변경 (title, age 미포함)
        await childRepo.save({
          id: saved.id,
          parent: parent2,
        });

        const rows = await rawQuery(
          `SELECT title, age, parentFk FROM ${qi(type, entities.childTableName)} WHERE id = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;

        expect(Number(row?.parentFk)).toBe(parent2.id);
        expect(row?.title).toBe("Switching Cat");
        expect(Number(row?.age)).toBe(3);
      });

      it("부분 업데이트에서 parentFk를 직접 변경할 수 있어야 한다", async () => {
        const parent1 = await parentRepo.save({ name: "FK Old" });
        const parent2 = await parentRepo.save({ name: "FK New" });
        const saved = await childRepo.save({
          title: "FK Switch",
          parentFk: parent1.id,
        });

        // 부분 업데이트: parentFk만 변경
        await childRepo.save({
          id: saved.id,
          parentFk: parent2.id,
        });

        const rows = await rawQuery(
          `SELECT parentFk, title FROM ${qi(type, entities.childTableName)} WHERE id = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;

        expect(Number(row?.parentFk)).toBe(parent2.id);
        expect(row?.title).toBe("FK Switch");
      });
    });

    // ─── M-6d: 부분 업데이트에서 FK 명시적 null 설정 ───────────────────────────

    describe("M-6d: 부분 업데이트에서 FK를 명시적으로 null 설정", () => {
      it("부분 업데이트에서 parent = null로 관계를 해제할 수 있어야 한다", async () => {
        const parent = await parentRepo.save({ name: "Detach Owner" });
        const saved = await childRepo.save({
          title: "Detach Cat",
          age: 4,
          parent: parent,
        });

        // 부분 업데이트: parent를 null로 (title, age 미포함)
        await childRepo.save({
          id: saved.id,
          parent: null,
        });

        const rows = await rawQuery(
          `SELECT title, age, parentFk FROM ${qi(type, entities.childTableName)} WHERE id = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;

        expect(row?.parentFk).toBeNull();
        // 다른 컬럼은 보존
        expect(row?.title).toBe("Detach Cat");
        expect(Number(row?.age)).toBe(4);
      });

      it("부분 업데이트에서 parentFk = null로 관계를 해제할 수 있어야 한다", async () => {
        const parent = await parentRepo.save({ name: "FK Detach" });
        const saved = await childRepo.save({
          title: "FK Detach Cat",
          age: 6,
          parentFk: parent.id,
        });

        // 부분 업데이트: parentFk를 null로
        await childRepo.save({
          id: saved.id,
          parentFk: null,
        });

        const rows = await rawQuery(
          `SELECT parentFk, title, age FROM ${qi(type, entities.childTableName)} WHERE id = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;

        expect(row?.parentFk).toBeNull();
        expect(row?.title).toBe("FK Detach Cat");
        expect(Number(row?.age)).toBe(6);
      });
    });
  });
});
