/**
 * SQLite In-Memory 관계(FK) 통합 테스트
 *
 * ManyToOne / OneToMany 시나리오를 SQLite in-memory에서 검증합니다.
 * 외부 DB 서버 불필요, CI에서 항상 실행 가능합니다.
 */

import "reflect-metadata";
import { SqliteConnector } from "../../../src/dialects/sqlite/SqliteConnector";
import { SqliteDriver } from "../../../src/dialects/sqlite/SqliteDriver";
import { DatabaseClientOptions } from "../../../src/core/DatabaseClientOptions";

describe("[Integration] SQLite In-Memory: 관계(FK) 테스트", () => {
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

    // 부모 테이블
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "parents" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL
      )
    `);

    // 자식 테이블 (FK → parents.id)
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "children" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL,
        "parentId" INTEGER,
        FOREIGN KEY ("parentId") REFERENCES "parents"("id") ON DELETE CASCADE
      )
    `);
  });

  afterAll(async () => {
    await connector.close();
  });

  beforeEach(async () => {
    await connector.query("DELETE FROM \"children\"");
    await connector.query("DELETE FROM \"parents\"");
  });

  // ─────────────────────────────────────────────────────────
  // FK INSERT
  // ─────────────────────────────────────────────────────────

  describe("FK 삽입", () => {
    it("부모 저장 후 자식을 FK와 함께 저장할 수 있어야 한다", async () => {
      const parent = await connector.query(
        "INSERT INTO \"parents\" (\"name\") VALUES ('Alice')",
      );
      const parentId = Number(parent.lastInsertRowid);

      const child = await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('Child of Alice', ${parentId})`,
      );
      expect(child.changes).toBe(1);
      expect(Number(child.lastInsertRowid)).toBeGreaterThan(0);
    });

    it("FK가 부모 id와 일치해야 한다", async () => {
      const parent = await connector.query(
        "INSERT INTO \"parents\" (\"name\") VALUES ('Bob')",
      );
      const parentId = Number(parent.lastInsertRowid);

      await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('Bob child', ${parentId})`,
      );

      const rows = await connector.query(
        "SELECT \"parentId\" FROM \"children\" WHERE \"title\" = 'Bob child'",
      );
      expect(rows[0].parentId).toBe(parentId);
    });

    it("FK가 null인 자식도 저장 가능해야 한다", async () => {
      const result = await connector.query(
        "INSERT INTO \"children\" (\"title\", \"parentId\") VALUES ('Orphan', NULL)",
      );
      expect(result.changes).toBe(1);

      const rows = await connector.query(
        "SELECT * FROM \"children\" WHERE \"title\" = 'Orphan'",
      );
      expect(rows[0].parentId).toBeNull();
    });

    it("한 부모에 여러 자식을 저장할 수 있어야 한다", async () => {
      const parent = await connector.query(
        "INSERT INTO \"parents\" (\"name\") VALUES ('Multi')",
      );
      const parentId = Number(parent.lastInsertRowid);

      await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('Child 1', ${parentId})`,
      );
      await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('Child 2', ${parentId})`,
      );
      await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('Child 3', ${parentId})`,
      );

      const rows = await connector.query(
        `SELECT COUNT(*) as cnt FROM "children" WHERE "parentId" = ${parentId}`,
      );
      expect(rows[0].cnt).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────
  // JOIN 조회
  // ─────────────────────────────────────────────────────────

  describe("JOIN 조회", () => {
    beforeEach(async () => {
      const p1 = await connector.query(
        "INSERT INTO \"parents\" (\"name\") VALUES ('Parent1')",
      );
      const p2 = await connector.query(
        "INSERT INTO \"parents\" (\"name\") VALUES ('Parent2')",
      );
      const p1Id = Number(p1.lastInsertRowid);
      const p2Id = Number(p2.lastInsertRowid);

      await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('C1', ${p1Id})`,
      );
      await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('C2', ${p1Id})`,
      );
      await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('C3', ${p2Id})`,
      );
    });

    it("LEFT JOIN으로 자식과 부모를 함께 조회할 수 있어야 한다", async () => {
      const rows = await connector.query(`
        SELECT c.*, p."name" as "parentName"
        FROM "children" c
        LEFT JOIN "parents" p ON c."parentId" = p."id"
        ORDER BY c."id"
      `);
      expect(rows.length).toBe(3);
      expect(rows[0].parentName).toBe("Parent1");
      expect(rows[2].parentName).toBe("Parent2");
    });

    it("GROUP BY로 부모별 자식 수를 집계할 수 있어야 한다", async () => {
      const rows = await connector.query(`
        SELECT p."name", COUNT(c."id") as "childCount"
        FROM "parents" p
        LEFT JOIN "children" c ON p."id" = c."parentId"
        GROUP BY p."id"
        ORDER BY p."name"
      `);
      expect(rows.length).toBe(2);
      expect(rows[0].name).toBe("Parent1");
      expect(rows[0].childCount).toBe(2);
      expect(rows[1].name).toBe("Parent2");
      expect(rows[1].childCount).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────
  // CASCADE DELETE
  // ─────────────────────────────────────────────────────────

  describe("Cascade Delete", () => {
    it("부모 삭제 시 ON DELETE CASCADE로 자식도 삭제되어야 한다", async () => {
      const parent = await connector.query(
        "INSERT INTO \"parents\" (\"name\") VALUES ('CascadeParent')",
      );
      const parentId = Number(parent.lastInsertRowid);

      await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('CC1', ${parentId})`,
      );
      await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('CC2', ${parentId})`,
      );

      // 부모 삭제
      const delResult = await connector.query(
        `DELETE FROM "parents" WHERE "id" = ${parentId}`,
      );
      expect(delResult.changes).toBe(1);

      // 자식도 cascade로 삭제 확인
      const children = await connector.query(
        `SELECT COUNT(*) as cnt FROM "children" WHERE "parentId" = ${parentId}`,
      );
      expect(children[0].cnt).toBe(0);
    });

    it("자식만 삭제해도 부모는 유지되어야 한다", async () => {
      const parent = await connector.query(
        "INSERT INTO \"parents\" (\"name\") VALUES ('Surviving')",
      );
      const parentId = Number(parent.lastInsertRowid);

      const child = await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('ToDelete', ${parentId})`,
      );
      const childId = Number(child.lastInsertRowid);

      await connector.query(`DELETE FROM "children" WHERE "id" = ${childId}`);

      const parents = await connector.query(
        `SELECT * FROM "parents" WHERE "id" = ${parentId}`,
      );
      expect(parents.length).toBe(1);
      expect(parents[0].name).toBe("Surviving");
    });
  });

  // ─────────────────────────────────────────────────────────
  // FK UPDATE
  // ─────────────────────────────────────────────────────────

  describe("FK 변경", () => {
    it("자식의 FK를 다른 부모로 변경할 수 있어야 한다", async () => {
      const p1 = await connector.query(
        "INSERT INTO \"parents\" (\"name\") VALUES ('OldParent')",
      );
      const p2 = await connector.query(
        "INSERT INTO \"parents\" (\"name\") VALUES ('NewParent')",
      );
      const child = await connector.query(
        `INSERT INTO "children" ("title", "parentId") VALUES ('Reassign', ${Number(p1.lastInsertRowid)})`,
      );

      await connector.query(
        `UPDATE "children" SET "parentId" = ${Number(p2.lastInsertRowid)} WHERE "id" = ${Number(child.lastInsertRowid)}`,
      );

      const rows = await connector.query(
        `SELECT "parentId" FROM "children" WHERE "id" = ${Number(child.lastInsertRowid)}`,
      );
      expect(rows[0].parentId).toBe(Number(p2.lastInsertRowid));
    });
  });
});
