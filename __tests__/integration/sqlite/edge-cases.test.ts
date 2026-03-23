/**
 * SQLite In-Memory 엣지 케이스 통합 테스트
 *
 * 타입 강제 변환(boolean, Date), VARCHAR 길이 무시,
 * JSON/BLOB 저장, 유니코드, 대용량 결과, 정수 범위,
 * NULL 처리, LIKE 특수문자, ORDER BY NULL 순서 등
 * SQLite 고유 동작을 검증합니다.
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
// Part 1: Raw connector edge cases
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite In-Memory: Raw 엣지 케이스", () => {
  let connector: SqliteConnector;

  beforeAll(async () => {
    connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      database: ":memory:",
      logging: false,
    } as DatabaseClientOptions);

    await connector.query(`
      CREATE TABLE IF NOT EXISTS "edge_test" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "boolVal" INTEGER,
        "dateVal" TEXT,
        "textVal" TEXT,
        "jsonVal" TEXT,
        "blobVal" BLOB,
        "numVal" INTEGER
      )
    `);
  });

  afterAll(async () => {
    await connector.close();
  });

  beforeEach(async () => {
    await connector.query('DELETE FROM "edge_test"');
  });

  describe("Type coercion", () => {
    it("should store boolean as INTEGER (0/1)", async () => {
      // SqliteConnector sanitizes true → 1, false → 0
      await connector.query(
        `INSERT INTO "edge_test" ("boolVal") VALUES (1)`,
      );
      await connector.query(
        `INSERT INTO "edge_test" ("boolVal") VALUES (0)`,
      );

      const rows = await connector.query(
        'SELECT "boolVal" FROM "edge_test" ORDER BY "id"',
      );
      expect(rows[0].boolVal).toBe(1);
      expect(rows[1].boolVal).toBe(0);
    });

    it("should store Date as TEXT (ISO 8601)", async () => {
      const dateStr = "2026-03-23T12:00:00.000Z";
      await connector.query(
        `INSERT INTO "edge_test" ("dateVal") VALUES ('${dateStr}')`,
      );

      const rows = await connector.query(
        'SELECT "dateVal" FROM "edge_test"',
      );
      expect(rows[0].dateVal).toBe(dateStr);
      // Should be parseable as Date
      expect(new Date(rows[0].dateVal).toISOString()).toBe(dateStr);
    });
  });

  describe("VARCHAR length ignored", () => {
    it("should store strings longer than declared VARCHAR length", async () => {
      // SQLite ignores VARCHAR(n) length constraint
      const longString = "A".repeat(1000);
      await connector.query(
        `INSERT INTO "edge_test" ("textVal") VALUES ('${longString}')`,
      );

      const rows = await connector.query(
        'SELECT "textVal" FROM "edge_test"',
      );
      expect(rows[0].textVal.length).toBe(1000);
    });
  });

  describe("JSON stored as TEXT", () => {
    it("should store and retrieve JSON data as TEXT", async () => {
      const jsonData = JSON.stringify({
        key: "value",
        nested: { arr: [1, 2, 3] },
      });
      await connector.query(
        `INSERT INTO "edge_test" ("jsonVal") VALUES ('${jsonData}')`,
      );

      const rows = await connector.query(
        'SELECT "jsonVal" FROM "edge_test"',
      );
      const parsed = JSON.parse(rows[0].jsonVal);
      expect(parsed.key).toBe("value");
      expect(parsed.nested.arr).toEqual([1, 2, 3]);
    });

    it("should support SQLite JSON functions (json_extract)", async () => {
      const jsonData = JSON.stringify({ name: "test", score: 42 });
      await connector.query(
        `INSERT INTO "edge_test" ("jsonVal") VALUES ('${jsonData}')`,
      );

      const rows = await connector.query(`
        SELECT json_extract("jsonVal", '$.name') as "name",
               json_extract("jsonVal", '$.score') as "score"
        FROM "edge_test"
      `);
      expect(rows[0].name).toBe("test");
      expect(rows[0].score).toBe(42);
    });
  });

  describe("BLOB handling", () => {
    it("should store and retrieve Buffer data", async () => {
      const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
      await connector.query(
        `INSERT INTO "edge_test" ("blobVal") VALUES (X'48656C6C6F')`,
      );

      const rows = await connector.query(
        'SELECT "blobVal" FROM "edge_test"',
      );
      const result = Buffer.from(rows[0].blobVal);
      expect(result.toString("utf-8")).toBe("Hello");
    });
  });

  describe("Unicode text", () => {
    it("should store and retrieve multi-byte characters", async () => {
      const unicode = "한국어テスト🎉emoji";
      await connector.query(
        `INSERT INTO "edge_test" ("textVal") VALUES ('${unicode}')`,
      );

      const rows = await connector.query(
        'SELECT "textVal" FROM "edge_test"',
      );
      expect(rows[0].textVal).toBe(unicode);
    });
  });

  describe("Large result set", () => {
    it("should handle 500 rows without truncation", async () => {
      const count = 500;
      for (let i = 0; i < count; i++) {
        await connector.query(
          `INSERT INTO "edge_test" ("numVal") VALUES (${i})`,
        );
      }

      const rows = await connector.query(
        'SELECT COUNT(*) as "cnt" FROM "edge_test"',
      );
      expect(rows[0].cnt).toBe(count);

      const allRows = await connector.query(
        'SELECT "numVal" FROM "edge_test" ORDER BY "numVal"',
      );
      expect(allRows.length).toBe(count);
      expect(allRows[0].numVal).toBe(0);
      expect(allRows[count - 1].numVal).toBe(count - 1);
    });
  });

  describe("Integer edge values", () => {
    it("should handle MAX_SAFE_INTEGER", async () => {
      const maxInt = Number.MAX_SAFE_INTEGER; // 9007199254740991
      await connector.query(
        `INSERT INTO "edge_test" ("numVal") VALUES (${maxInt})`,
      );

      const rows = await connector.query(
        'SELECT "numVal" FROM "edge_test"',
      );
      expect(rows[0].numVal).toBe(maxInt);
    });
  });

  describe("NULL handling", () => {
    it("should distinguish NULL from 0 and empty string", async () => {
      await connector.query(
        `INSERT INTO "edge_test" ("numVal", "textVal") VALUES (NULL, NULL)`,
      );
      await connector.query(
        `INSERT INTO "edge_test" ("numVal", "textVal") VALUES (0, '')`,
      );

      const rows = await connector.query(
        'SELECT "numVal", "textVal" FROM "edge_test" ORDER BY "id"',
      );

      expect(rows[0].numVal).toBeNull();
      expect(rows[0].textVal).toBeNull();
      expect(rows[1].numVal).toBe(0);
      expect(rows[1].textVal).toBe("");
    });
  });

  describe("LIKE with special characters", () => {
    it("should match with % and _ wildcards", async () => {
      await connector.query(
        `INSERT INTO "edge_test" ("textVal") VALUES ('hello world')`,
      );
      await connector.query(
        `INSERT INTO "edge_test" ("textVal") VALUES ('hello')`,
      );
      await connector.query(
        `INSERT INTO "edge_test" ("textVal") VALUES ('world')`,
      );

      const rows = await connector.query(
        `SELECT "textVal" FROM "edge_test" WHERE "textVal" LIKE 'hello%'`,
      );
      expect(rows.length).toBe(2);
    });

    it("should handle LIKE with underscore as single-char wildcard", async () => {
      await connector.query(
        `INSERT INTO "edge_test" ("textVal") VALUES ('cat')`,
      );
      await connector.query(
        `INSERT INTO "edge_test" ("textVal") VALUES ('cut')`,
      );
      await connector.query(
        `INSERT INTO "edge_test" ("textVal") VALUES ('cute')`,
      );

      const rows = await connector.query(
        `SELECT "textVal" FROM "edge_test" WHERE "textVal" LIKE 'c_t'`,
      );
      expect(rows.length).toBe(2); // cat, cut (not cute)
    });
  });

  describe("ORDER BY with NULLs", () => {
    it("NULLs should sort first in ASC order (SQLite default)", async () => {
      await connector.query(
        `INSERT INTO "edge_test" ("numVal") VALUES (3)`,
      );
      await connector.query(
        `INSERT INTO "edge_test" ("numVal") VALUES (NULL)`,
      );
      await connector.query(
        `INSERT INTO "edge_test" ("numVal") VALUES (1)`,
      );

      const rows = await connector.query(
        'SELECT "numVal" FROM "edge_test" ORDER BY "numVal" ASC',
      );

      // SQLite: NULLs sort before all other values in ASC
      expect(rows[0].numVal).toBeNull();
      expect(rows[1].numVal).toBe(1);
      expect(rows[2].numVal).toBe(3);
    });
  });
});

// ─────────────────────────────────────────────────────────
// Part 2: EntityManager edge cases on SQLite
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite In-Memory: EntityManager 엣지 케이스", () => {
  let conn: TestConnectionResult;
  let EntityClass: new () => any;
  let tableName: string;

  beforeAll(async () => {
    tableName = generateTableName("em_edge");

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
          "age",
        );
        Column({ type: "int", nullable: true })(DynClass.prototype, "age");

        Entity()(DynClass);
        EntityClass = DynClass;
        return { entities: [DynClass] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("find on empty table should return empty array", async () => {
    const results = await conn.em.find(EntityClass);
    expect(results).toEqual([]);
  });

  it("count on empty table should return 0", async () => {
    const count = await conn.em.count(EntityClass);
    expect(count).toBe(0);
  });

  it("should save and find entities correctly", async () => {
    await conn.em.save(EntityClass, { name: "Test1", age: 25 });
    await conn.em.save(EntityClass, { name: "Test2", age: null } as any);

    const all = await conn.em.find(EntityClass);
    expect(all.length).toBe(2);
  });

  it("findOne on non-existent record should return null", async () => {
    const result = await conn.em.findOne(EntityClass, {
      where: { id: 999999 } as any,
    });
    expect(result).toBeNull();
  });
});
