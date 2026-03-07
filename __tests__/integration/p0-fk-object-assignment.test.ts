/**
 * P0 통합 테스트 — FK 처리 핵심 경로
 *
 * 자동화 테스트 맹점에서 발견된 버그 영역을 검증합니다.
 *
 * ## 시나리오
 * - J-2: ManyToOne 관계 객체 할당 후 save (cat.owner = ownerEntity)
 * - J-3: FK 컬럼 직접 지정 (parentFk: parent.id)
 * - M-1: 부모 재할당 (parent = parent2)
 * - M-2: 관계 해제 (parent = null)
 * - S-7: FK 값이 falsy(0)인 경우
 *
 * ## 핵심 원칙
 * 모든 테스트는 save() → DB round-trip → findOne()으로 실제 DB 상태를 검증합니다.
 * mock이 아닌 실제 DB에 데이터가 올바르게 반영되는지 확인합니다.
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
  createOneToManyTestEntities,
  type RelatedEntitiesResult,
} from "./helpers/create-relation-entity";
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

describeIf("[P0] FK 객체 할당 패턴 통합 테스트", () => {
  describe.each(drivers)("$label", ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entities: RelatedEntitiesResult;
    let parentRepo: BaseRepository<any>;
    let childRepo: BaseRepository<any>;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entities = createOneToManyTestEntities("p0_fk");
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

    // ─── J-2: ManyToOne 관계 객체 할당 후 save ─────────────────────────────────

    describe("J-2: 관계 객체 할당 → save()", () => {
      it("parent 객체를 할당하고 save하면 FK가 DB에 저장되어야 한다", async () => {
        const parent = await parentRepo.save({ name: "Alice" });

        // 사용자 패턴: 관계 객체 직접 할당
        const saved = await childRepo.save({
          title: "Nabi",
          parent: parent,
        });

        // DB round-trip 검증
        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;

        expect(child).toBeDefined();
        expect(child.parent).toBeDefined();
        expect(child.parent).not.toBeNull();
        expect(child.parent.id).toBe(parent.id);
        expect(child.parent.name).toBe("Alice");
      });

      it("DB에서 raw 쿼리로 FK 컬럼 값을 직접 확인한다", async () => {
        const parent = await parentRepo.save({ name: "Bob" });
        const saved = await childRepo.save({
          title: "Cheese",
          parent: parent,
        });

        const rows = await rawQuery(
          `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;

        expect(Number(row?.parentFk)).toBe(parent.id);
      });

      it("INSERT 시 parent 객체 할당이 동작해야 한다 (id 없는 새 자식)", async () => {
        const parent = await parentRepo.save({ name: "Charlie" });

        // id가 없으므로 INSERT 경로
        const saved = await childRepo.save({
          title: "New Cat",
          parent: parent,
        });

        expect(saved.id).toBeGreaterThan(0);

        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;
        expect(child.parent.id).toBe(parent.id);
      });
    });

    // ─── J-3: FK 컬럼 직접 지정 ────────────────────────────────────────────────

    describe("J-3: FK 컬럼 직접 지정 (parentFk)", () => {
      it("parentFk에 직접 값을 넣으면 FK가 저장되어야 한다", async () => {
        const parent = await parentRepo.save({ name: "Direct FK" });
        const saved = await childRepo.save({
          title: "Direct Child",
          parentFk: parent.id,
        });

        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;

        expect(child.parent).toBeDefined();
        expect(child.parent.id).toBe(parent.id);
      });

      it("J-2(객체 할당)와 J-3(FK 직접)의 결과가 동일해야 한다", async () => {
        const parent = await parentRepo.save({ name: "Compare Parent" });

        // 방법 1: 객체 할당
        const byObject = await childRepo.save({
          title: "By Object",
          parent: parent,
        });

        // 방법 2: FK 직접
        const byFk = await childRepo.save({
          title: "By FK",
          parentFk: parent.id,
        });

        // 두 방법 모두 같은 부모를 참조해야 한다
        const found1 = await childRepo.findOne({ where: { id: byObject.id } });
        const found2 = await childRepo.findOne({ where: { id: byFk.id } });
        const c1 = Array.isArray(found1) ? found1[0] : found1;
        const c2 = Array.isArray(found2) ? found2[0] : found2;

        expect(c1.parent.id).toBe(parent.id);
        expect(c2.parent.id).toBe(parent.id);
        expect(c1.parent.name).toBe(c2.parent.name);
      });
    });

    // ─── M-1: 부모 재할당 ──────────────────────────────────────────────────────

    describe("M-1: ManyToOne 관계 변경 (부모 재할당)", () => {
      it("parent를 다른 객체로 교체하면 FK가 변경되어야 한다", async () => {
        const parent1 = await parentRepo.save({ name: "Owner1" });
        const parent2 = await parentRepo.save({ name: "Owner2" });

        // 최초: parent1에 연결
        const saved = await childRepo.save({
          title: "Reassign Cat",
          parent: parent1,
        });

        // 재할당: parent2로 변경
        await childRepo.save({
          id: saved.id,
          title: "Reassign Cat",
          parent: parent2,
        });

        // DB 검증
        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;

        expect(child.parent.id).toBe(parent2.id);
        expect(child.parent.name).toBe("Owner2");
      });

      it("재할당 후 이전 부모의 children에서 제거되어야 한다", async () => {
        const parent1 = await parentRepo.save({ name: "Old Owner" });
        const parent2 = await parentRepo.save({ name: "New Owner" });

        const saved = await childRepo.save({
          title: "Moving Cat",
          parent: parent1,
        });

        // parent2로 재할당
        await childRepo.save({
          id: saved.id,
          title: "Moving Cat",
          parent: parent2,
        });

        // 이전 부모의 children 확인
        const oldParent = await parentRepo.findOne({
          where: { id: parent1.id },
          relations: ["children"],
        } as any);
        const op = Array.isArray(oldParent) ? oldParent[0] : oldParent;
        const oldChildren = op?.children ?? [];
        expect(oldChildren.length).toBe(0);

        // 새 부모의 children 확인
        const newParent = await parentRepo.findOne({
          where: { id: parent2.id },
          relations: ["children"],
        } as any);
        const np = Array.isArray(newParent) ? newParent[0] : newParent;
        expect(np.children.length).toBe(1);
        expect(np.children[0].title).toBe("Moving Cat");
      });

      it("FK 직접 변경도 동일하게 동작해야 한다", async () => {
        const parent1 = await parentRepo.save({ name: "FK Old" });
        const parent2 = await parentRepo.save({ name: "FK New" });

        const saved = await childRepo.save({
          title: "FK Reassign",
          parentFk: parent1.id,
        });

        await childRepo.save({
          id: saved.id,
          title: "FK Reassign",
          parentFk: parent2.id,
        });

        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;
        expect(child.parent.id).toBe(parent2.id);
      });
    });

    // ─── M-2: 관계 해제 (null 할당) ───────────────────────────────────────────

    describe("M-2: ManyToOne 관계 해제 (null 할당)", () => {
      it("parent = null로 저장하면 FK가 NULL이 되어야 한다", async () => {
        const parent = await parentRepo.save({ name: "Soon Null" });
        const saved = await childRepo.save({
          title: "Will Be Orphan",
          parent: parent,
        });

        // 관계 해제
        await childRepo.save({
          id: saved.id,
          title: "Will Be Orphan",
          parent: null,
        });

        // DB raw 검증
        const rows = await rawQuery(
          `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
        );
        const rs = rows?.results ?? rows;
        const row = Array.isArray(rs) ? rs[0] : rs;
        expect(row?.parentFk).toBeNull();
      });

      it("null 할당 후 eager 로딩 시 parent가 null이어야 한다", async () => {
        const parent = await parentRepo.save({ name: "Temp Owner" });
        const saved = await childRepo.save({
          title: "Orphan Cat",
          parent: parent,
        });

        await childRepo.save({
          id: saved.id,
          title: "Orphan Cat",
          parent: null,
        });

        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;
        expect(child.parent == null).toBe(true);
      });

      it("null 할당 후 이전 부모의 children에서 사라져야 한다", async () => {
        const parent = await parentRepo.save({ name: "Losing Owner" });
        const saved = await childRepo.save({
          title: "Leaving Cat",
          parent: parent,
        });

        await childRepo.save({
          id: saved.id,
          title: "Leaving Cat",
          parent: null,
        });

        const found = await parentRepo.findOne({
          where: { id: parent.id },
          relations: ["children"],
        } as any);
        const p = Array.isArray(found) ? found[0] : found;
        const children = p?.children ?? [];
        expect(children.length).toBe(0);
      });

      it("FK 직접 null 할당도 동일하게 동작해야 한다", async () => {
        const parent = await parentRepo.save({ name: "FK Null" });
        const saved = await childRepo.save({
          title: "FK Null Cat",
          parentFk: parent.id,
        });

        await childRepo.save({
          id: saved.id,
          title: "FK Null Cat",
          parentFk: null,
        });

        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;
        expect(child.parent == null).toBe(true);
      });

      it("parent1 → null → parent2 순차 변경이 올바르게 동작해야 한다", async () => {
        const parent1 = await parentRepo.save({ name: "First" });
        const parent2 = await parentRepo.save({ name: "Second" });

        // Step 1: parent1 연결
        const saved = await childRepo.save({
          title: "Cycle Cat",
          parent: parent1,
        });

        let found = await childRepo.findOne({ where: { id: saved.id } });
        let child = Array.isArray(found) ? found[0] : found;
        expect(child.parent.id).toBe(parent1.id);

        // Step 2: null로 해제
        await childRepo.save({
          id: saved.id,
          title: "Cycle Cat",
          parent: null,
        });

        found = await childRepo.findOne({ where: { id: saved.id } });
        child = Array.isArray(found) ? found[0] : found;
        expect(child.parent == null).toBe(true);

        // Step 3: parent2 연결
        await childRepo.save({
          id: saved.id,
          title: "Cycle Cat",
          parent: parent2,
        });

        found = await childRepo.findOne({ where: { id: saved.id } });
        child = Array.isArray(found) ? found[0] : found;
        expect(child.parent.id).toBe(parent2.id);
        expect(child.parent.name).toBe("Second");
      });
    });

    // ─── S-7: FK 값이 falsy(0)인 경우 (MySQL 전용) ──────────────────────────────

    (type === "mysql" ? describe : describe.skip)(
      "S-7: Falsy FK 값 처리",
      () => {
        it("parentFk: 0 을 저장하면 null이 아닌 0이 DB에 기록되어야 한다", async () => {
          // MySQL에서 id=0인 부모를 생성하기 위해 sql_mode 설정
          await rawQuery("SET sql_mode='NO_AUTO_VALUE_ON_ZERO'");
          await rawQuery(
            `INSERT INTO \`${entities.parentTableName}\` (id, name) VALUES (0, 'ZeroParent')`,
          );

          // FK 제약이 있으므로 실제 id=0 부모가 존재해야 FK=0 저장 가능
          const saved = await childRepo.save({
            title: "Zero FK Child",
            parentFk: 0,
          });

          const rows = await rawQuery(
            `SELECT parentFk FROM \`${entities.childTableName}\` WHERE id = ${saved.id}`,
          );
          const rs = rows?.results ?? rows;
          const row = Array.isArray(rs) ? rs[0] : rs;

          // 0이 null로 변환되지 않아야 한다
          expect(row?.parentFk).not.toBeNull();
          expect(Number(row?.parentFk)).toBe(0);

          // sql_mode 복원
          await rawQuery("SET sql_mode=''");
        });

        it("id=0인 부모 객체를 할당해도 FK가 0으로 저장되어야 한다", async () => {
          await rawQuery("SET sql_mode='NO_AUTO_VALUE_ON_ZERO'");
          await rawQuery(
            `INSERT IGNORE INTO \`${entities.parentTableName}\` (id, name) VALUES (0, 'ZeroObj')`,
          );

          // parent 객체를 직접 구성 (id=0)
          const zeroParent = { id: 0, name: "ZeroObj" };
          const saved = await childRepo.save({
            title: "Zero Obj Child",
            parent: zeroParent,
          });

          const found = await childRepo.findOne({ where: { id: saved.id } });
          const child = Array.isArray(found) ? found[0] : found;

          expect(child.parent).toBeDefined();
          expect(child.parent).not.toBeNull();
          expect(child.parent.id).toBe(0);

          await rawQuery("SET sql_mode=''");
        });
      },
    );
  });
});
