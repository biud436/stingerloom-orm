/**
 * SQLite In-Memory 기본 CRUD 통합 테스트
 *
 * better-sqlite3를 사용한 in-memory 데이터베이스로 실행하므로
 * 외부 DB 서버가 필요 없습니다. CI에서도 항상 실행 가능합니다.
 *
 * SqliteConnector + SqliteDriver를 직접 사용하여
 * CREATE TABLE / INSERT / SELECT / UPDATE / DELETE 전체 사이클을 검증합니다.
 */

import "reflect-metadata";
import { SqliteConnector } from "../../../src/dialects/sqlite/SqliteConnector";
import { SqliteDriver } from "../../../src/dialects/sqlite/SqliteDriver";
import { DatabaseClientOptions } from "../../../src/core/DatabaseClientOptions";

describe("[Integration] SQLite In-Memory: 기본 CRUD 테스트", () => {
  let connector: SqliteConnector;
  let driver: SqliteDriver;

  beforeAll(async () => {
    connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      database: ":memory:",
      logging: false,
    } as DatabaseClientOptions);
    driver = new SqliteDriver(connector);
  });

  afterAll(async () => {
    await connector.close();
  });

  // ─────────────────────────────────────────────────────────
  // TABLE CREATION
  // ─────────────────────────────────────────────────────────

  describe("테이블 생성", () => {
    it("createTable로 테이블을 생성할 수 있어야 한다", async () => {
      await driver.createTable("users", [
        {
          name: "id",
          options: {
            type: "int",
            nullable: false,
            primary: true,
            autoIncrement: true,
          },
        },
        {
          name: "name",
          options: { type: "varchar", length: 255, nullable: false },
        },
        {
          name: "age",
          options: { type: "int", nullable: false },
        },
        {
          name: "email",
          options: { type: "varchar", length: 255, nullable: true },
        },
      ]);

      const tables = await driver.hasTable("users");
      expect(Array.isArray(tables)).toBe(true);
      expect(tables.length).toBeGreaterThan(0);
    });

    it("hasTable로 존재하지 않는 테이블을 조회하면 빈 배열이어야 한다", async () => {
      const tables = await driver.hasTable("nonexistent_table");
      expect(Array.isArray(tables)).toBe(true);
      expect(tables.length).toBe(0);
    });

    it("getSchemas로 테이블 컬럼 정보를 조회할 수 있어야 한다", async () => {
      const columns = await driver.getSchemas("users");
      expect(Array.isArray(columns)).toBe(true);
      expect(columns.length).toBe(4);

      const colNames = columns.map((c: any) => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("name");
      expect(colNames).toContain("age");
      expect(colNames).toContain("email");
    });
  });

  // ─────────────────────────────────────────────────────────
  // INSERT (CREATE)
  // ─────────────────────────────────────────────────────────

  describe("Insert (CREATE)", () => {
    afterEach(async () => {
      await connector.query("DELETE FROM \"users\"");
    });

    it("INSERT 후 lastInsertRowid가 반환되어야 한다", async () => {
      const result = await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\", \"email\") VALUES ('Alice', 25, 'alice@test.com')",
      );
      expect(result).toBeDefined();
      expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
      expect(result.changes).toBe(1);
    });

    it("여러 행을 순차 삽입하면 lastInsertRowid가 증가해야 한다", async () => {
      const r1 = await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\") VALUES ('User1', 20)",
      );
      const r2 = await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\") VALUES ('User2', 25)",
      );
      const r3 = await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\") VALUES ('User3', 30)",
      );

      expect(Number(r1.lastInsertRowid)).toBeLessThan(
        Number(r2.lastInsertRowid),
      );
      expect(Number(r2.lastInsertRowid)).toBeLessThan(
        Number(r3.lastInsertRowid),
      );
    });

    it("nullable 컬럼에 NULL을 삽입할 수 있어야 한다", async () => {
      const result = await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\", \"email\") VALUES ('NoEmail', 20, NULL)",
      );
      expect(result.changes).toBe(1);

      const rows = await connector.query(
        `SELECT * FROM "users" WHERE "id" = ${Number(result.lastInsertRowid)}`,
      );
      expect(rows[0].email).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────
  // SELECT (READ)
  // ─────────────────────────────────────────────────────────

  describe("Select (READ)", () => {
    beforeEach(async () => {
      await connector.query("DELETE FROM \"users\"");
      await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\", \"email\") VALUES ('Alice', 25, 'alice@test.com')",
      );
      await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\", \"email\") VALUES ('Bob', 30, 'bob@test.com')",
      );
      await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\", \"email\") VALUES ('Charlie', 35, NULL)",
      );
    });

    it("SELECT *로 전체 행을 조회할 수 있어야 한다", async () => {
      const rows = await connector.query("SELECT * FROM \"users\"");
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(3);
    });

    it("WHERE 조건으로 단일 행을 조회할 수 있어야 한다", async () => {
      const rows = await connector.query(
        "SELECT * FROM \"users\" WHERE \"name\" = 'Alice'",
      );
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Alice");
      expect(rows[0].age).toBe(25);
      expect(rows[0].email).toBe("alice@test.com");
    });

    it("WHERE 조건으로 여러 행을 필터링할 수 있어야 한다", async () => {
      const rows = await connector.query(
        "SELECT * FROM \"users\" WHERE \"age\" >= 30",
      );
      expect(rows.length).toBe(2);
    });

    it("존재하지 않는 조건으로 조회하면 빈 배열이어야 한다", async () => {
      const rows = await connector.query(
        "SELECT * FROM \"users\" WHERE \"name\" = 'NonExistent'",
      );
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(0);
    });

    it("COUNT(*)로 행 수를 조회할 수 있어야 한다", async () => {
      const rows = await connector.query(
        "SELECT COUNT(*) as cnt FROM \"users\"",
      );
      expect(rows[0].cnt).toBe(3);
    });

    it("ORDER BY로 정렬 조회할 수 있어야 한다", async () => {
      const rows = await connector.query(
        "SELECT * FROM \"users\" ORDER BY \"age\" DESC",
      );
      expect(rows[0].name).toBe("Charlie");
      expect(rows[2].name).toBe("Alice");
    });

    it("LIMIT으로 결과 수를 제한할 수 있어야 한다", async () => {
      const rows = await connector.query(
        "SELECT * FROM \"users\" ORDER BY \"age\" LIMIT 2",
      );
      expect(rows.length).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────
  // UPDATE
  // ─────────────────────────────────────────────────────────

  describe("Update", () => {
    let insertedId: number;

    beforeEach(async () => {
      await connector.query("DELETE FROM \"users\"");
      const result = await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\", \"email\") VALUES ('Diana', 28, 'diana@test.com')",
      );
      insertedId = Number(result.lastInsertRowid);
    });

    it("UPDATE로 컬럼 값을 변경할 수 있어야 한다", async () => {
      const result = await connector.query(
        `UPDATE "users" SET "name" = 'Diana Updated', "age" = 29 WHERE "id" = ${insertedId}`,
      );
      expect(result.changes).toBe(1);

      const rows = await connector.query(
        `SELECT * FROM "users" WHERE "id" = ${insertedId}`,
      );
      expect(rows[0].name).toBe("Diana Updated");
      expect(rows[0].age).toBe(29);
    });

    it("UPDATE 후에도 id가 변하지 않아야 한다", async () => {
      await connector.query(
        `UPDATE "users" SET "name" = 'Modified' WHERE "id" = ${insertedId}`,
      );

      const rows = await connector.query(
        `SELECT * FROM "users" WHERE "id" = ${insertedId}`,
      );
      expect(rows[0].id).toBe(insertedId);
    });

    it("존재하지 않는 행을 UPDATE하면 changes가 0이어야 한다", async () => {
      const result = await connector.query(
        "UPDATE \"users\" SET \"name\" = 'Ghost' WHERE \"id\" = 99999",
      );
      expect(result.changes).toBe(0);
    });

    it("여러 행을 한 번에 UPDATE할 수 있어야 한다", async () => {
      await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\") VALUES ('Batch1', 20)",
      );
      await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\") VALUES ('Batch2', 20)",
      );

      const result = await connector.query(
        "UPDATE \"users\" SET \"age\" = 99 WHERE \"age\" = 20",
      );
      expect(result.changes).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────────────────

  describe("Delete", () => {
    beforeEach(async () => {
      await connector.query("DELETE FROM \"users\"");
      await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\") VALUES ('ToDelete1', 40)",
      );
      await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\") VALUES ('ToDelete2', 40)",
      );
      await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\") VALUES ('ToKeep', 50)",
      );
    });

    it("DELETE로 단일 행을 삭제할 수 있어야 한다", async () => {
      const rows = await connector.query(
        "SELECT * FROM \"users\" WHERE \"name\" = 'ToDelete1'",
      );
      const id = rows[0].id;

      const result = await connector.query(
        `DELETE FROM "users" WHERE "id" = ${id}`,
      );
      expect(result.changes).toBe(1);

      const remaining = await connector.query(
        "SELECT COUNT(*) as cnt FROM \"users\"",
      );
      expect(remaining[0].cnt).toBe(2);
    });

    it("조건에 맞는 여러 행을 삭제할 수 있어야 한다", async () => {
      const result = await connector.query(
        "DELETE FROM \"users\" WHERE \"age\" = 40",
      );
      expect(result.changes).toBe(2);

      const remaining = await connector.query("SELECT * FROM \"users\"");
      expect(remaining.length).toBe(1);
      expect(remaining[0].name).toBe("ToKeep");
    });

    it("존재하지 않는 조건으로 DELETE하면 changes가 0이어야 한다", async () => {
      const result = await connector.query(
        "DELETE FROM \"users\" WHERE \"id\" = 99999",
      );
      expect(result.changes).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // FULL LIFECYCLE
  // ─────────────────────────────────────────────────────────

  describe("전체 CRUD 라이프사이클", () => {
    it("Create -> Read -> Update -> Read -> Delete -> Read 전체 흐름이 동작해야 한다", async () => {
      await connector.query("DELETE FROM \"users\"");

      // CREATE
      const insertResult = await connector.query(
        "INSERT INTO \"users\" (\"name\", \"age\", \"email\") VALUES ('Lifecycle', 25, 'lc@test.com')",
      );
      const id = Number(insertResult.lastInsertRowid);
      expect(id).toBeGreaterThan(0);

      // READ
      let rows = await connector.query(
        `SELECT * FROM "users" WHERE "id" = ${id}`,
      );
      expect(rows[0].name).toBe("Lifecycle");
      expect(rows[0].age).toBe(25);

      // UPDATE
      const updateResult = await connector.query(
        `UPDATE "users" SET "name" = 'Lifecycle Updated', "age" = 26 WHERE "id" = ${id}`,
      );
      expect(updateResult.changes).toBe(1);

      // READ after UPDATE
      rows = await connector.query(
        `SELECT * FROM "users" WHERE "id" = ${id}`,
      );
      expect(rows[0].name).toBe("Lifecycle Updated");
      expect(rows[0].age).toBe(26);

      // DELETE
      const deleteResult = await connector.query(
        `DELETE FROM "users" WHERE "id" = ${id}`,
      );
      expect(deleteResult.changes).toBe(1);

      // READ after DELETE
      rows = await connector.query(
        `SELECT * FROM "users" WHERE "id" = ${id}`,
      );
      expect(rows.length).toBe(0);
    });
  });
});
