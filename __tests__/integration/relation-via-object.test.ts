/**
 * ManyToOne 관계 객체를 통한 FK 저장 통합 테스트
 *
 * 기존 통합 테스트는 `parentFk: parent.id` (@Column 직접 설정) 패턴만 검증했습니다.
 * 이 파일은 실제 사용자가 ORM을 사용하는 3가지 수준의 시나리오를 검증합니다:
 *
 * - Junior: 기본 관계 할당과 save() (가장 직관적인 패턴)
 * - Middle: 관계 변경·해제·재할당 등 실무 CRUD 시나리오
 * - Senior: 엣지 케이스, 동시성, 데이터 무결성 검증
 *
 * ## 핵심 차이
 * 기존 테스트: `childRepo.save({ parentFk: parent.id })`  ← @Column 직접
 * 이 테스트:   `child.parent = parentEntity; save(child)` ← 관계 객체 할당
 *
 * ## 실행 전 필요 사항
 * - MySQL/PostgreSQL 서버 실행 중
 * - INTEGRATION_TEST=true 환경 변수
 * - examples/nestjs-cats/.env 연결 정보가 유효
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

const SKIP = !process.env.INTEGRATION_TEST;

const drivers = getTestDrivers();

(SKIP ? describe.skip : describe)(
  "[Integration] ManyToOne 관계 객체를 통한 FK 저장",
  () => {
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
            entities = createOneToManyTestEntities("rel_obj");
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

      // ═════════════════════════════════════════════════════════════════════════════
      // Junior — "ORM이니까 객체만 넣으면 되겠지"
      // 가장 직관적인 사용법. 문서 없이 감으로 쓰는 패턴.
      // ═════════════════════════════════════════════════════════════════════════════

      describe("Junior — 기본 관계 객체 할당", () => {
        it("부모 객체를 할당하고 save()하면 FK가 DB에 저장되어야 한다", async () => {
          const parent = await parentRepo.save({ name: "Alice" });

          const child = new entities.ChildClass();
          child.title = "Alice's cat";
          child.parent = parent; // ← 관계 객체 할당 (parentFk 직접 설정 아님)

          const saved = await childRepo.save(child);
          expect(saved.id).toBeGreaterThan(0);

          // DB에서 FK 값 직접 확인
          const rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          expect(Number(row?.parentFk)).toBe(parent.id);
        });

        it("save() 후 findOne()으로 조회하면 eager 로드된 parent가 있어야 한다", async () => {
          const parent = await parentRepo.save({ name: "Bob" });

          const child = new entities.ChildClass();
          child.title = "Bob's dog";
          child.parent = parent;
          const saved = await childRepo.save(child);

          const found = await childRepo.findOne({
            where: { id: saved.id },
          });
          const result = Array.isArray(found) ? found[0] : found;

          expect(result).toBeDefined();
          expect(result.parent).toBeDefined();
          expect(result.parent.id).toBe(parent.id);
          expect(result.parent.name).toBe("Bob");
        });

        it("부모 없이(parent 미할당) save()하면 FK가 NULL이어야 한다", async () => {
          const child = new entities.ChildClass();
          child.title = "Orphan";
          // parent 할당 안 함

          const saved = await childRepo.save(child);

          const rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          expect(row?.parentFk).toBeNull();
        });
      });

      // ═════════════════════════════════════════════════════════════════════════════
      // Middle — "관계를 바꾸거나 끊어야 하는데?"
      // 실무에서 자주 발생하는 관계 CRUD 시나리오.
      // ═════════════════════════════════════════════════════════════════════════════

      describe("Middle — 관계 변경·해제·재할당", () => {
        it("기존 관계를 다른 부모로 변경하면 FK가 업데이트되어야 한다", async () => {
          const parent1 = await parentRepo.save({ name: "Original" });
          const parent2 = await parentRepo.save({ name: "New" });

          const child = new entities.ChildClass();
          child.title = "Reassignable";
          child.parent = parent1;
          const saved = await childRepo.save(child);

          // 관계 변경
          saved.parent = parent2;
          await childRepo.save(saved);

          const rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          expect(Number(row?.parentFk)).toBe(parent2.id);
        });

        it("관계를 null로 설정하면 FK가 NULL이 되어야 한다", async () => {
          const parent = await parentRepo.save({ name: "Soon-to-leave" });

          const child = new entities.ChildClass();
          child.title = "Will be orphaned";
          child.parent = parent;
          const saved = await childRepo.save(child);

          // FK 확인 (설정됨)
          let rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
          );
          let row = (rows?.results ?? rows)?.[0];
          expect(Number(row?.parentFk)).toBe(parent.id);

          // 관계 해제
          saved.parent = null;
          await childRepo.save(saved);

          // FK 확인 (NULL)
          rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
          );
          row = (rows?.results ?? rows)?.[0];
          expect(row?.parentFk).toBeNull();
        });

        it("null에서 다시 부모를 할당하면 FK가 복원되어야 한다", async () => {
          const parent = await parentRepo.save({ name: "Returning" });

          // FK 없이 생성
          const child = new entities.ChildClass();
          child.title = "Orphan-to-child";
          const saved = await childRepo.save(child);

          // 부모 할당
          saved.parent = parent;
          await childRepo.save(saved);

          const rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          expect(Number(row?.parentFk)).toBe(parent.id);
        });

        it("연속으로 관계를 할당→해제→재할당해도 최종 상태가 DB에 반영되어야 한다", async () => {
          const parent1 = await parentRepo.save({ name: "P1" });
          const parent2 = await parentRepo.save({ name: "P2" });

          const child = new entities.ChildClass();
          child.title = "Bouncing";
          child.parent = parent1;
          const saved = await childRepo.save(child);

          // 해제
          saved.parent = null;
          await childRepo.save(saved);

          // 재할당
          saved.parent = parent2;
          await childRepo.save(saved);

          const rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          expect(Number(row?.parentFk)).toBe(parent2.id);
        });

        it("여러 자식을 같은 부모에 관계 객체로 할당할 수 있어야 한다", async () => {
          const parent = await parentRepo.save({ name: "Multi" });

          for (let i = 1; i <= 3; i++) {
            const child = new entities.ChildClass();
            child.title = `Child ${i}`;
            child.parent = parent;
            await childRepo.save(child);
          }

          const rows = await rawQuery(
            `SELECT COUNT(*) AS cnt FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "parentFk")} = ${parent.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          expect(Number(row?.cnt)).toBe(3);
        });
      });

      // ═════════════════════════════════════════════════════════════════════════════
      // Senior — "이거 진짜 DB에 반영됐나? 엣지 케이스는?"
      // 데이터 무결성 검증, findOne 결과로 수정 후 재저장, 혼합 패턴 등.
      // ═════════════════════════════════════════════════════════════════════════════

      describe("Senior — 엣지 케이스·데이터 무결성", () => {
        it("findOne 결과의 eager 로드된 관계를 변경하고 save()하면 FK가 바뀌어야 한다", async () => {
          const parent1 = await parentRepo.save({ name: "Initial" });
          const parent2 = await parentRepo.save({ name: "Replaced" });

          // @Column으로 FK 설정 (기존 방식)
          await childRepo.save({
            title: "Found child",
            parentFk: parent1.id,
          });

          // findOne으로 조회 (eager → parent 객체 로드됨)
          const allChildren = await childRepo.find({});
          const list = Array.isArray(allChildren)
            ? allChildren
            : [allChildren];
          const found = list.find((c: any) => c.title === "Found child");
          expect(found).toBeDefined();
          expect(found.parent).toBeDefined();
          expect(found.parent.id).toBe(parent1.id);

          // eager 로드된 관계를 다른 부모로 변경
          found.parent = parent2;
          await childRepo.save(found);

          // DB 직접 검증
          const rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${found.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          expect(Number(row?.parentFk)).toBe(parent2.id);
        });

        it("findOne 결과의 관계를 null로 설정하고 save()하면 FK가 NULL이어야 한다", async () => {
          const parent = await parentRepo.save({
            name: "Will be detached",
          });
          await childRepo.save({
            title: "Detachable",
            parentFk: parent.id,
          });

          const allChildren = await childRepo.find({});
          const list = Array.isArray(allChildren)
            ? allChildren
            : [allChildren];
          const found = list.find((c: any) => c.title === "Detachable");
          expect(found.parent.id).toBe(parent.id);

          // 관계 해제
          found.parent = null;
          await childRepo.save(found);

          const rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${found.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          expect(row?.parentFk).toBeNull();
        });

        it("@Column FK와 관계 객체를 동시에 설정하면 관계 객체의 PK가 우선해야 한다", async () => {
          const parent1 = await parentRepo.save({ name: "Column FK" });
          const parent2 = await parentRepo.save({ name: "Object FK" });

          const child = new entities.ChildClass();
          child.title = "Mixed";
          child.parentFk = parent1.id; // @Column 직접
          child.parent = parent2; // 관계 객체 (이쪽이 우선)

          const saved = await childRepo.save(child);

          const rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          // 관계 객체의 PK(parent2.id)가 INSERT SQL 뒤쪽에서 덮어쓰므로 우선
          expect(Number(row?.parentFk)).toBe(parent2.id);
        });

        it("존재하지 않는 부모 PK로 관계 객체를 만들면 FK 제약 위반이어야 한다", async () => {
          const fakeParent = new entities.ParentClass();
          fakeParent.id = 999999;
          fakeParent.name = "Ghost";

          const child = new entities.ChildClass();
          child.title = "Invalid FK";
          child.parent = fakeParent;

          await expect(childRepo.save(child)).rejects.toThrow();
        });

        it("같은 자식을 여러 번 save()해도 FK가 일관되게 유지되어야 한다", async () => {
          const parent = await parentRepo.save({ name: "Stable" });

          const child = new entities.ChildClass();
          child.title = "Repeated save";
          child.parent = parent;

          const saved = await childRepo.save(child);

          // 같은 객체 반복 save
          for (let i = 0; i < 3; i++) {
            saved.parent = parent;
            await childRepo.save(saved);
          }

          const rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          expect(Number(row?.parentFk)).toBe(parent.id);
        });

        it("부모를 삭제한 후 자식의 FK가 참조 무결성에 따라 처리되어야 한다", async () => {
          const parent = await parentRepo.save({ name: "Deletable" });

          const child = new entities.ChildClass();
          child.title = "Orphaned by delete";
          child.parent = parent;
          const saved = await childRepo.save(child);

          // 먼저 자식의 FK를 해제해야 부모 삭제 가능 (FK 제약)
          saved.parent = null;
          await childRepo.save(saved);

          // FK NULL 확인
          const rows = await rawQuery(
            `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "id")} = ${saved.id}`,
          );
          const row = (rows?.results ?? rows)?.[0];
          expect(row?.parentFk).toBeNull();

          // 이제 부모 삭제 가능
          await parentRepo.delete({ id: parent.id } as any);

          const parentRows = await rawQuery(
            `SELECT COUNT(*) AS cnt FROM ${qi(type, entities.parentTableName)} WHERE ${qi(type, "id")} = ${parent.id}`,
          );
          const pr = (parentRows?.results ?? parentRows)?.[0];
          expect(Number(pr?.cnt)).toBe(0);
        });
      });
    });
  },
);
