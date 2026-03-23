/**
 * SQLite In-Memory 집계(Aggregation) 통합 테스트
 *
 * COUNT, SUM, AVG, MIN, MAX, GROUP BY, HAVING, DISTINCT 등
 * 집계 관련 시나리오를 raw SQL과 EntityManager 양쪽에서 검증합니다.
 */

import "reflect-metadata";
import { SqliteConnector } from "../../../src/dialects/sqlite/SqliteConnector";
import { SqliteDriver } from "../../../src/dialects/sqlite/SqliteDriver";
import { DatabaseClientOptions } from "../../../src/core/DatabaseClientOptions";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../../src";
import Container from "typedi";
import { ColumnScanner } from "../../../src/scanner";
import { generateTableName } from "../helpers/create-test-entity";

// ─────────────────────────────────────────────────────────
// Part 1: Raw SQL aggregation tests
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite In-Memory: Raw SQL 집계 테스트", () => {
  let connector: SqliteConnector;

  beforeAll(async () => {
    connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      database: ":memory:",
      logging: false,
    } as DatabaseClientOptions);

    await connector.query(`
      CREATE TABLE "scores" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "player" TEXT NOT NULL,
        "team" TEXT NOT NULL,
        "points" INTEGER,
        "rating" REAL
      )
    `);
  });

  afterAll(async () => {
    await connector.close();
  });

  beforeEach(async () => {
    await connector.query('DELETE FROM "scores"');

    // Seed data
    await connector.query(
      `INSERT INTO "scores" ("player", "team", "points", "rating") VALUES ('Alice', 'Red', 10, 4.5)`,
    );
    await connector.query(
      `INSERT INTO "scores" ("player", "team", "points", "rating") VALUES ('Bob', 'Red', 20, 3.8)`,
    );
    await connector.query(
      `INSERT INTO "scores" ("player", "team", "points", "rating") VALUES ('Charlie', 'Blue', 15, 4.2)`,
    );
    await connector.query(
      `INSERT INTO "scores" ("player", "team", "points", "rating") VALUES ('Dave', 'Blue', 25, NULL)`,
    );
    await connector.query(
      `INSERT INTO "scores" ("player", "team", "points", "rating") VALUES ('Eve', 'Green', NULL, 3.0)`,
    );
  });

  describe("Basic aggregates", () => {
    it("COUNT(*) should count all rows", async () => {
      const rows = await connector.query(
        'SELECT COUNT(*) as "cnt" FROM "scores"',
      );
      expect(rows[0].cnt).toBe(5);
    });

    it("COUNT(column) should exclude NULLs", async () => {
      const rows = await connector.query(
        'SELECT COUNT("points") as "cnt" FROM "scores"',
      );
      expect(rows[0].cnt).toBe(4); // Eve's points is NULL
    });

    it("SUM should sum non-NULL values", async () => {
      const rows = await connector.query(
        'SELECT SUM("points") as "total" FROM "scores"',
      );
      expect(rows[0].total).toBe(70); // 10+20+15+25
    });

    it("AVG should average non-NULL values", async () => {
      const rows = await connector.query(
        'SELECT AVG("points") as "average" FROM "scores"',
      );
      expect(rows[0].average).toBeCloseTo(17.5, 1); // 70/4
    });

    it("MIN and MAX should return extremes", async () => {
      const rows = await connector.query(
        'SELECT MIN("points") as "min", MAX("points") as "max" FROM "scores"',
      );
      expect(rows[0].min).toBe(10);
      expect(rows[0].max).toBe(25);
    });
  });

  describe("GROUP BY", () => {
    it("should group and aggregate by team", async () => {
      const rows = await connector.query(`
        SELECT "team", SUM("points") as "total", COUNT(*) as "cnt"
        FROM "scores"
        GROUP BY "team"
        ORDER BY "team"
      `);

      expect(rows.length).toBe(3);
      expect(rows[0]).toEqual({ team: "Blue", total: 40, cnt: 2 });
      expect(rows[1]).toEqual({ team: "Green", total: null, cnt: 1 });
      expect(rows[2]).toEqual({ team: "Red", total: 30, cnt: 2 });
    });

    it("should GROUP BY multiple columns", async () => {
      // Add duplicate team+points combo
      await connector.query(
        `INSERT INTO "scores" ("player", "team", "points", "rating") VALUES ('Frank', 'Red', 10, 4.0)`,
      );

      const rows = await connector.query(`
        SELECT "team", "points", COUNT(*) as "cnt"
        FROM "scores"
        WHERE "points" IS NOT NULL
        GROUP BY "team", "points"
        ORDER BY "team", "points"
      `);

      const red10 = rows.find(
        (r: any) => r.team === "Red" && r.points === 10,
      );
      expect(red10?.cnt).toBe(2); // Alice + Frank
    });
  });

  describe("HAVING", () => {
    it("should filter groups with HAVING", async () => {
      const rows = await connector.query(`
        SELECT "team", SUM("points") as "total"
        FROM "scores"
        GROUP BY "team"
        HAVING SUM("points") >= 30
        ORDER BY "total" DESC
      `);

      expect(rows.length).toBe(2);
      expect(rows[0].team).toBe("Blue"); // 40
      expect(rows[1].team).toBe("Red"); // 30
    });

    it("should support multiple HAVING conditions", async () => {
      const rows = await connector.query(`
        SELECT "team", COUNT(*) as "cnt", AVG("rating") as "avgRating"
        FROM "scores"
        GROUP BY "team"
        HAVING COUNT(*) >= 2 AND AVG("rating") IS NOT NULL
        ORDER BY "team"
      `);

      // Blue: cnt=2, avgRating=4.2 (Dave is NULL, only Charlie counted)
      // Red: cnt=2, avgRating=4.15
      expect(rows.length).toBe(2);
    });
  });

  describe("NULL handling in aggregates", () => {
    it("SUM of all NULLs should return NULL", async () => {
      await connector.query('DELETE FROM "scores"');
      await connector.query(
        `INSERT INTO "scores" ("player", "team", "points", "rating") VALUES ('X', 'A', NULL, NULL)`,
      );

      const rows = await connector.query(
        'SELECT SUM("points") as "total" FROM "scores"',
      );
      expect(rows[0].total).toBeNull();
    });

    it("AVG should exclude NULLs from denominator", async () => {
      const rows = await connector.query(
        'SELECT AVG("rating") as "avg" FROM "scores"',
      );
      // 4.5 + 3.8 + 4.2 + 3.0 = 15.5 / 4 = 3.875 (Dave's NULL excluded)
      expect(rows[0].avg).toBeCloseTo(3.875, 2);
    });
  });

  describe("DISTINCT with aggregates", () => {
    it("COUNT(DISTINCT team) should count unique teams", async () => {
      const rows = await connector.query(
        'SELECT COUNT(DISTINCT "team") as "cnt" FROM "scores"',
      );
      expect(rows[0].cnt).toBe(3);
    });

    it("DISTINCT in joined results should remove duplicates", async () => {
      await connector.query(`
        CREATE TABLE IF NOT EXISTS "j_authors" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "name" TEXT NOT NULL
        )
      `);
      await connector.query(`
        CREATE TABLE IF NOT EXISTS "j_posts" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "authorId" INTEGER
        )
      `);

      const a = await connector.query(
        `INSERT INTO "j_authors" ("name") VALUES ('Author1')`,
      );
      const aId = Number(a.lastInsertRowid);
      await connector.query(
        `INSERT INTO "j_posts" ("authorId") VALUES (${aId})`,
      );
      await connector.query(
        `INSERT INTO "j_posts" ("authorId") VALUES (${aId})`,
      );

      const rows = await connector.query(`
        SELECT DISTINCT a."name"
        FROM "j_authors" a
        INNER JOIN "j_posts" p ON a."id" = p."authorId"
      `);

      expect(rows.length).toBe(1); // not 2

      await connector.query('DROP TABLE IF EXISTS "j_posts"');
      await connector.query('DROP TABLE IF EXISTS "j_authors"');
    });
  });

  describe("Aggregate across JOINs", () => {
    it("should count related rows via JOIN + GROUP BY", async () => {
      await connector.query(`
        CREATE TABLE IF NOT EXISTS "departments" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "name" TEXT NOT NULL
        )
      `);
      await connector.query(`
        CREATE TABLE IF NOT EXISTS "members" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "name" TEXT NOT NULL,
          "deptId" INTEGER,
          FOREIGN KEY ("deptId") REFERENCES "departments"("id")
        )
      `);

      const d1 = await connector.query(
        `INSERT INTO "departments" ("name") VALUES ('Engineering')`,
      );
      const d2 = await connector.query(
        `INSERT INTO "departments" ("name") VALUES ('Marketing')`,
      );
      const d1Id = Number(d1.lastInsertRowid);
      const d2Id = Number(d2.lastInsertRowid);

      await connector.query(
        `INSERT INTO "members" ("name", "deptId") VALUES ('M1', ${d1Id})`,
      );
      await connector.query(
        `INSERT INTO "members" ("name", "deptId") VALUES ('M2', ${d1Id})`,
      );
      await connector.query(
        `INSERT INTO "members" ("name", "deptId") VALUES ('M3', ${d1Id})`,
      );
      await connector.query(
        `INSERT INTO "members" ("name", "deptId") VALUES ('M4', ${d2Id})`,
      );

      const rows = await connector.query(`
        SELECT d."name", COUNT(m."id") as "memberCount"
        FROM "departments" d
        LEFT JOIN "members" m ON d."id" = m."deptId"
        GROUP BY d."id"
        ORDER BY "memberCount" DESC
      `);

      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual({ name: "Engineering", memberCount: 3 });
      expect(rows[1]).toEqual({ name: "Marketing", memberCount: 1 });

      await connector.query('DROP TABLE IF EXISTS "members"');
      await connector.query('DROP TABLE IF EXISTS "departments"');
    });
  });
});

// ─────────────────────────────────────────────────────────
// Part 2: EntityManager aggregation tests on SQLite
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite In-Memory: EntityManager 집계 테스트", () => {
  let conn: TestConnectionResult;
  let EntityClass: new () => any;
  let tableName: string;

  beforeAll(async () => {
    tableName = generateTableName("agg_em");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        Container.get(ColumnScanner).clear();

        const DynClass = class {} as any;
        Object.defineProperty(DynClass, "name", {
          value: tableName,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
        PrimaryGeneratedColumn()(DynClass.prototype, "id");

        Reflect.defineMetadata(
          "design:type",
          String,
          DynClass.prototype,
          "name",
        );
        Column()(DynClass.prototype, "name");

        Reflect.defineMetadata(
          "design:type",
          Number,
          DynClass.prototype,
          "score",
        );
        Column({ type: "int", nullable: true })(DynClass.prototype, "score");

        Entity()(DynClass);

        EntityClass = DynClass;
        return { entities: [DynClass] };
      },
    );

    // Seed
    const { em } = conn;
    await em.save(EntityClass, { name: "Alice", score: 100 });
    await em.save(EntityClass, { name: "Bob", score: 80 });
    await em.save(EntityClass, { name: "Charlie", score: 90 });
    await em.save(EntityClass, { name: "Dave", score: null } as any);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("em.count() should return total row count", async () => {
    const count = await conn.em.count(EntityClass);
    expect(count).toBe(4);
  });

  it("em.count() with where should filter", async () => {
    const count = await conn.em.count(EntityClass, { name: "Alice" } as any);
    expect(count).toBe(1);
  });

  it("em.sum() should sum non-NULL values", async () => {
    const total = await conn.em.sum(EntityClass, "score" as any);
    expect(total).toBe(270); // 100+80+90
  });

  it("em.avg() should average non-NULL values", async () => {
    const avg = await conn.em.avg(EntityClass, "score" as any);
    expect(avg).toBeCloseTo(90, 0); // 270/3
  });

  it("em.min() should return minimum", async () => {
    const min = await conn.em.min(EntityClass, "score" as any);
    expect(min).toBe(80);
  });

  it("em.max() should return maximum", async () => {
    const max = await conn.em.max(EntityClass, "score" as any);
    expect(max).toBe(100);
  });

  it("em.findAndCount() should return entities and count", async () => {
    const [entities, count] = await conn.em.findAndCount(EntityClass, {
      limit: 2,
      orderBy: { name: "ASC" } as any,
    });

    expect(entities.length).toBe(2);
    expect(count).toBe(4);
  });
});
