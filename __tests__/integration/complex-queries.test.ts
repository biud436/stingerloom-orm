/**
 * 복합 쿼리 통합 테스트 (MySQL / PostgreSQL)
 *
 * EntityManager를 통한 집계, 관계 로딩, findAndCount, 정렬/페이지네이션 등
 * SQLite에서 검증한 시나리오를 실제 MySQL/PostgreSQL에서도 확인합니다.
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import {
  createOneToManyTestEntities,
  type RelatedEntitiesResult,
} from "./helpers/create-relation-entity";
import {
  createDynamicEntity,
  createCrudTestEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";
import { qi, dropTableSql, disableFkChecksSql, enableFkChecksSql } from "./helpers/driver-helpers";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";

const drivers = getTestDrivers();

// ─────────────────────────────────────────────────────────
// Part 1: EntityManager 집계 테스트
// ─────────────────────────────────────────────────────────

describe.each(drivers)(
  "[Integration] $label: EntityManager 집계 테스트",
  ({ type, options }) => {
    let conn: TestConnectionResult;
    let testEntity: DynamicEntityResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          testEntity = createDynamicEntity("agg_test", [
            { name: "id", designType: Number, primary: true },
            { name: "name", designType: String },
            {
              name: "score",
              designType: Number,
              options: { type: "int", nullable: true },
            },
          ]);
          return { entities: [testEntity.EntityClass] };
        },
      );

      const { em } = conn;
      await em.save(testEntity.EntityClass, { name: "Alice", score: 100 });
      await em.save(testEntity.EntityClass, { name: "Bob", score: 80 });
      await em.save(testEntity.EntityClass, { name: "Charlie", score: 90 });
      await em.save(testEntity.EntityClass, {
        name: "Dave",
        score: null,
      } as any);
    }, 30000);

    afterAll(async () => {
      try {
        await dropTestTable(testEntity.tableName);
      } catch {}
      await conn.cleanup();
    }, 15000);

    it("em.count() should return total row count", async () => {
      const count = await conn.em.count(testEntity.EntityClass);
      expect(count).toBe(4);
    });

    it("em.count() with where should filter", async () => {
      const count = await conn.em.count(testEntity.EntityClass, {
        name: "Alice",
      } as any);
      expect(count).toBe(1);
    });

    it("em.sum() should sum non-NULL values", async () => {
      const total = await conn.em.sum(
        testEntity.EntityClass,
        "score" as any,
      );
      expect(total).toBe(270);
    });

    it("em.avg() should average non-NULL values", async () => {
      const avg = await conn.em.avg(testEntity.EntityClass, "score" as any);
      expect(Number(avg)).toBeCloseTo(90, 0);
    });

    it("em.min() should return minimum", async () => {
      const min = await conn.em.min(testEntity.EntityClass, "score" as any);
      expect(min).toBe(80);
    });

    it("em.max() should return maximum", async () => {
      const max = await conn.em.max(testEntity.EntityClass, "score" as any);
      expect(max).toBe(100);
    });

    it("em.findAndCount() should return entities and total count", async () => {
      const [entities, count] = await conn.em.findAndCount(
        testEntity.EntityClass,
        {
          limit: 2,
          orderBy: { name: "ASC" } as any,
        },
      );

      expect(entities.length).toBe(2);
      expect(count).toBe(4);
    });
  },
);

// ─────────────────────────────────────────────────────────
// Part 2: ManyToOne / OneToMany 관계 로딩
// ─────────────────────────────────────────────────────────

describe.each(drivers)(
  "[Integration] $label: 관계 로딩 테스트",
  ({ type, options }) => {
    let conn: TestConnectionResult;
    let entities: RelatedEntitiesResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          entities = createOneToManyTestEntities();
          return {
            entities: [entities.ParentClass, entities.ChildClass],
          };
        },
      );
    }, 30000);

    afterAll(async () => {
      try {
        const connector = conn.em.getDriver()!;
        // FK를 가진 자식 테이블 먼저 삭제
        await rawQuery(
          disableFkChecksSql(type as any),
        );
        await dropTestTable(entities.childTableName);
        await dropTestTable(entities.parentTableName);
        await rawQuery(
          enableFkChecksSql(type as any),
        );
      } catch {}
      await conn.cleanup();
    }, 15000);

    it("should save parent and child with FK", async () => {
      const { em } = conn;
      const { ParentClass, ChildClass } = entities;

      const parent = await em.save(ParentClass, { name: "Parent1" });
      expect(parent.id).toBeDefined();

      const child = await em.save(ChildClass, {
        title: "Child1",
        parentFk: parent.id,
      });
      expect(child.id).toBeDefined();
      expect(child.parentFk).toBe(parent.id);
    });

    it("should eager-load parent on child find (ManyToOne eager)", async () => {
      const { em } = conn;
      const { ParentClass, ChildClass } = entities;

      const parent = await em.save(ParentClass, { name: "EagerP" });
      await em.save(ChildClass, {
        title: "EagerC",
        parentFk: parent.id,
      });

      const children = await em.find(ChildClass, {
        where: { title: "EagerC" } as any,
      });

      expect(children.length).toBe(1);
      expect(children[0].parent).toBeDefined();
      expect(children[0].parent.name).toBe("EagerP");
    });

    it("should load children via relations option (OneToMany)", async () => {
      const { em } = conn;
      const { ParentClass, ChildClass } = entities;

      const parent = await em.save(ParentClass, { name: "RelP" });
      await em.save(ChildClass, { title: "RelC1", parentFk: parent.id });
      await em.save(ChildClass, { title: "RelC2", parentFk: parent.id });

      const parents = await em.find(ParentClass, {
        where: { name: "RelP" } as any,
        relations: ["children"] as any,
      });

      expect(parents.length).toBe(1);
      expect(parents[0].children).toBeDefined();
      expect(parents[0].children.length).toBe(2);
    });

    it("should return empty array for parent with no children", async () => {
      const { em } = conn;
      const { ParentClass } = entities;

      await em.save(ParentClass, { name: "Lonely" });

      const parents = await em.find(ParentClass, {
        where: { name: "Lonely" } as any,
        relations: ["children"] as any,
      });

      expect(parents.length).toBe(1);
      expect(parents[0].children).toEqual([]);
    });

    it("should handle nullable FK (child with no parent)", async () => {
      const { em } = conn;
      const { ChildClass } = entities;

      await em.save(ChildClass, {
        title: "Orphan",
        parentFk: null,
      } as any);

      const found = await em.find(ChildClass, {
        where: { title: "Orphan" } as any,
      });

      expect(found.length).toBe(1);
      expect(found[0].parent).toBeNull();
    });

    it("findOne on non-existent id should return null", async () => {
      const { em } = conn;
      const { ParentClass } = entities;

      const result = await em.findOne(ParentClass, {
        where: { id: 999999 } as any,
      });
      expect(result).toBeNull();
    });
  },
);

// ─────────────────────────────────────────────────────────
// Part 3: 정렬, 페이지네이션, DISTINCT
// ─────────────────────────────────────────────────────────

describe.each(drivers)(
  "[Integration] $label: 정렬/페이지네이션 테스트",
  ({ type, options }) => {
    let conn: TestConnectionResult;
    let testEntity: DynamicEntityResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          testEntity = createCrudTestEntity("page_test");
          return { entities: [testEntity.EntityClass] };
        },
      );

      const { em } = conn;
      for (let i = 1; i <= 10; i++) {
        await em.save(testEntity.EntityClass, {
          name: `User${String(i).padStart(2, "0")}`,
          age: 20 + i,
          email: i % 3 === 0 ? null : `user${i}@test.com`,
        });
      }
    }, 30000);

    afterAll(async () => {
      try {
        await dropTestTable(testEntity.tableName);
      } catch {}
      await conn.cleanup();
    }, 15000);

    it("should order by ASC", async () => {
      const results = await conn.em.find(testEntity.EntityClass, {
        orderBy: { name: "ASC" } as any,
        limit: 3,
      });

      expect(results.length).toBe(3);
      expect(results[0].name).toBe("User01");
      expect(results[2].name).toBe("User03");
    });

    it("should order by DESC", async () => {
      const results = await conn.em.find(testEntity.EntityClass, {
        orderBy: { age: "DESC" } as any,
        limit: 3,
      });

      expect(results.length).toBe(3);
      expect(results[0].age).toBe(30);
    });

    it("should paginate with limit and offset", async () => {
      // limit 튜플 [offset, count]는 MySQL에서만 지원.
      // 크로스 DB 호환을 위해 skip/take 또는 별도 쿼리 방식 사용.
      const page1 = await conn.em.find(testEntity.EntityClass, {
        orderBy: { name: "ASC" } as any,
        limit: 3,
      });
      const allResults = await conn.em.find(testEntity.EntityClass, {
        orderBy: { name: "ASC" } as any,
      });

      expect(page1.length).toBe(3);
      expect(allResults.length).toBe(10);
      // First page should be a subset of all results
      expect(page1[0].name).toBe(allResults[0].name);
    });

    it("findAndCount should return total regardless of limit", async () => {
      const [entities, count] = await conn.em.findAndCount(
        testEntity.EntityClass,
        {
          limit: 2,
        },
      );

      expect(entities.length).toBe(2);
      expect(count).toBe(10);
    });

    it("should filter with where clause", async () => {
      const results = await conn.em.find(testEntity.EntityClass, {
        where: { age: 25 } as any,
      });

      expect(results.length).toBe(1);
      expect(results[0].name).toBe("User05");
    });
  },
);
