/**
 * core (non-buffer) cascade delete — 세션 재사용 & 원자성 통합 테스트 (#414)
 *
 * WriteExecutor.delete()의 cascadeDeleteOneToMany는 자식 DELETE(와 부모 PK
 * SELECT)를 공용 ctx.delete/ctx.find로 발행합니다. #414 이전에는 이 호출들이
 * 바깥 delete의 세션에 합류하지 못하고 별도 트랜잭션을 열어, 부모 delete가
 * 롤백돼도 자식은 이미 커밋된 채 사라졌습니다(원자성 위반). 수정 후에는
 * 바깥 세션이 ALS로 전파되어 부모+자식이 한 트랜잭션으로 묶입니다.
 *
 * 검증 항목 (MySQL / PostgreSQL 공통):
 * - 단일 부모 cascade delete — 자식까지 삭제
 * - 다중 부모 criteria — 매칭된 모든 부모의 자식 삭제 (IN), 무관한 행 보존
 * - 원자성 — afterDelete subscriber가 던지면 부모/자식 모두 복원
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
  createCascadeDeleteTestEntities,
  type RelatedEntitiesResult,
} from "./helpers/create-relation-entity";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";
import {
  qi,
  disableFkChecksSql,
  enableFkChecksSql,
} from "./helpers/driver-helpers";
import type { EntitySubscriber } from "../../src/core/EntitySubscriber";

describe.each(getTestDrivers())(
  "[Integration] $label: core cascade delete — 세션 재사용 & 원자성 (#414)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entities: RelatedEntitiesResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entities = createCascadeDeleteTestEntities();
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
      await truncateTestTable(entities.childTableName);
      await truncateTestTable(entities.parentTableName);
    });

    async function countRows(tableName: string): Promise<number> {
      const rows = (await em.query(
        `SELECT COUNT(*) AS cnt FROM ${qi(type, tableName)}`,
      )) as any[];
      return Number(rows[0].cnt);
    }

    it("단일 부모 cascade delete — 자식이 같은 트랜잭션에서 삭제된다", async () => {
      const a: any = await em.save(entities.ParentClass, {
        name: "A",
        grp: "del",
      } as any);
      await em.save(entities.ChildClass, { title: "a1", parentFk: a.id } as any);
      await em.save(entities.ChildClass, { title: "a2", parentFk: a.id } as any);

      const result = await em.delete(entities.ParentClass, { id: a.id } as any);
      expect(result.affected).toBe(1);

      expect(await countRows(entities.parentTableName)).toBe(0);
      expect(await countRows(entities.childTableName)).toBe(0);
    });

    it("다중 부모 criteria — 매칭된 부모들의 자식만 IN으로 삭제된다", async () => {
      const a: any = await em.save(entities.ParentClass, {
        name: "A",
        grp: "del",
      } as any);
      const b: any = await em.save(entities.ParentClass, {
        name: "B",
        grp: "del",
      } as any);
      const keep: any = await em.save(entities.ParentClass, {
        name: "C",
        grp: "keep",
      } as any);
      await em.save(entities.ChildClass, { title: "a1", parentFk: a.id } as any);
      await em.save(entities.ChildClass, { title: "b1", parentFk: b.id } as any);
      await em.save(entities.ChildClass, { title: "k1", parentFk: keep.id } as any);

      await em.delete(entities.ParentClass, { grp: "del" } as any);

      const parents = (await em.query(
        `SELECT ${qi(type, "name")} AS name FROM ${qi(type, entities.parentTableName)}`,
      )) as any[];
      expect(parents.map((p) => p.name)).toEqual(["C"]);

      const children = (await em.query(
        `SELECT ${qi(type, "title")} AS title, ${qi(type, "parentFk")} AS pfk FROM ${qi(type, entities.childTableName)}`,
      )) as any[];
      expect(children).toHaveLength(1);
      expect(children[0].title).toBe("k1");
      expect(Number(children[0].pfk)).toBe(keep.id);
    });

    it("원자성 — afterDelete subscriber가 던지면 부모와 자식이 모두 복원된다", async () => {
      const a: any = await em.save(entities.ParentClass, {
        name: "A",
        grp: "del",
      } as any);
      await em.save(entities.ChildClass, { title: "a1", parentFk: a.id } as any);

      // afterDelete는 delete 트랜잭션 안에서(자식·부모 삭제 후) 실행되므로,
      // 여기서 던지면 전체가 롤백되어야 한다. #414 이전에는 자식 DELETE가
      // 별도 트랜잭션에서 이미 커밋되어 자식만 유실됐다.
      const failing: EntitySubscriber<any> = {
        listenTo: () => entities.ParentClass as any,
        afterDelete: async () => {
          throw new Error("afterDelete boom");
        },
      };
      em.addSubscriber(failing);
      try {
        await expect(
          em.delete(entities.ParentClass, { id: a.id } as any),
        ).rejects.toThrow("afterDelete boom");
      } finally {
        em.removeSubscriber(failing);
      }

      expect(await countRows(entities.parentTableName)).toBe(1);
      expect(await countRows(entities.childTableName)).toBe(1);
    });
  },
);
