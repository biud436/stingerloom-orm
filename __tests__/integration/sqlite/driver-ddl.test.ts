/**
 * SQLite In-Memory 드라이버 DDL 통합 테스트
 *
 * SqliteDriver의 DDL 메서드(createTable, addColumn, dropColumn,
 * addIndex, addUniqueKey, addCompositeUniqueIndex 등)를
 * 실제 in-memory DB에서 검증합니다.
 */

import "reflect-metadata";
import { SqliteConnector } from "../../../src/dialects/sqlite/SqliteConnector";
import { SqliteDriver } from "../../../src/dialects/sqlite/SqliteDriver";
import { DatabaseClientOptions } from "../../../src/core/DatabaseClientOptions";

describe("[Integration] SQLite In-Memory: 드라이버 DDL 테스트", () => {
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
  // createTable
  // ─────────────────────────────────────────────────────────

  describe("createTable", () => {
    it("다양한 컬럼 타입으로 테이블을 생성할 수 있어야 한다", async () => {
      await driver.createTable("ddl_test", [
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
          options: { type: "varchar", length: 100, nullable: false },
        },
        {
          name: "score",
          options: { type: "float", nullable: true },
        },
        {
          name: "active",
          options: { type: "boolean", nullable: false },
        },
        {
          name: "data",
          options: { type: "json", nullable: true },
        },
      ]);

      const tables = await driver.hasTable("ddl_test");
      expect(tables.length).toBeGreaterThan(0);

      const columns = await driver.getSchemas("ddl_test");
      const colNames = columns.map((c: any) => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("name");
      expect(colNames).toContain("score");
      expect(colNames).toContain("active");
      expect(colNames).toContain("data");
    });

    it("CREATE TABLE IF NOT EXISTS는 중복 실행해도 에러가 없어야 한다", async () => {
      await expect(
        driver.createTable("ddl_test", [
          {
            name: "id",
            options: {
              type: "int",
              nullable: false,
              primary: true,
              autoIncrement: true,
            },
          },
        ]),
      ).resolves.not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────
  // addColumn / hasColumn
  // ─────────────────────────────────────────────────────────

  describe("addColumn / hasColumn", () => {
    it("addColumn으로 새 컬럼을 추가할 수 있어야 한다", async () => {
      await driver.addColumn("ddl_test", "extra", "TEXT");

      const has = await driver.hasColumn("ddl_test", "extra");
      expect(has).toBe(true);
    });

    it("존재하지 않는 컬럼은 hasColumn이 false여야 한다", async () => {
      const has = await driver.hasColumn("ddl_test", "nonexistent");
      expect(has).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────
  // addIndex / hasIndex / dropIndex
  // ─────────────────────────────────────────────────────────

  describe("인덱스 관리", () => {
    it("addIndex로 인덱스를 추가할 수 있어야 한다", async () => {
      await driver.addIndex("ddl_test", "name", "idx_ddl_test_name");

      const result = await driver.hasIndex("ddl_test", "idx_ddl_test_name");
      const count = Array.isArray(result)
        ? result[0]?.count ?? 0
        : (result as any)?.count ?? 0;
      expect(Number(count)).toBeGreaterThan(0);
    });

    it("dropIndex로 인덱스를 삭제할 수 있어야 한다", async () => {
      await driver.dropIndex("ddl_test", "idx_ddl_test_name");

      const result = await driver.hasIndex("ddl_test", "idx_ddl_test_name");
      const count = Array.isArray(result)
        ? result[0]?.count ?? 0
        : (result as any)?.count ?? 0;
      expect(Number(count)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // addUniqueKey / dropUniqueKey
  // ─────────────────────────────────────────────────────────

  describe("유니크 키", () => {
    it("addUniqueKey로 유니크 인덱스를 추가할 수 있어야 한다", async () => {
      await driver.addUniqueKey("ddl_test", "name");

      const indexes = await driver.getIndexes("ddl_test");
      const uniqueIdx = (indexes as any[]).find(
        (idx: any) => idx.name === "uq_ddl_test_name",
      );
      expect(uniqueIdx).toBeDefined();
    });

    it("유니크 제약이 있으면 중복 값 INSERT가 실패해야 한다", async () => {
      // 인덱스가 없으면 직접 생성 (이전 테스트 상태에 의존하지 않음)
      const indexes = await driver.getIndexes("ddl_test");
      const hasIdx = (indexes as any[]).some(
        (idx: any) => idx.name === "uq_ddl_test_name",
      );
      if (!hasIdx) {
        await driver.addUniqueKey("ddl_test", "name");
      }

      // 기존 데이터 정리 후 삽입
      await connector.query(
        "DELETE FROM \"ddl_test\" WHERE \"name\" = 'unique_val'",
      );
      await connector.query(
        "INSERT INTO \"ddl_test\" (\"name\", \"active\") VALUES ('unique_val', 1)",
      );

      await expect(
        connector.query(
          "INSERT INTO \"ddl_test\" (\"name\", \"active\") VALUES ('unique_val', 0)",
        ),
      ).rejects.toThrow();
    });

    it("dropUniqueKey로 유니크 인덱스를 삭제할 수 있어야 한다", async () => {
      // 인덱스가 없으면 먼저 생성 (이전 테스트 상태에 의존하지 않음)
      const indexesBefore = await driver.getIndexes("ddl_test");
      const hasIdx = (indexesBefore as any[]).some(
        (idx: any) => idx.name === "uq_ddl_test_name",
      );
      if (!hasIdx) {
        await driver.addUniqueKey("ddl_test", "name");
      }

      await driver.dropUniqueKey("ddl_test", "name");

      const indexes = await driver.getIndexes("ddl_test");
      const uniqueIdx = (indexes as any[]).find(
        (idx: any) => idx.name === "uq_ddl_test_name",
      );
      expect(uniqueIdx).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────
  // addCompositeUniqueIndex
  // ─────────────────────────────────────────────────────────

  describe("복합 유니크 인덱스", () => {
    beforeAll(async () => {
      await connector.query(`
        CREATE TABLE IF NOT EXISTS "composite_test" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "col_a" TEXT NOT NULL,
          "col_b" TEXT NOT NULL
        )
      `);
    });

    it("addCompositeUniqueIndex로 복합 유니크 인덱스를 추가할 수 있어야 한다", async () => {
      await driver.addCompositeUniqueIndex(
        "composite_test",
        ["col_a", "col_b"],
        "uq_composite_ab",
      );

      const indexes = await driver.getIndexes("composite_test");
      const compositeIdx = (indexes as any[]).find(
        (idx: any) => idx.name === "uq_composite_ab",
      );
      expect(compositeIdx).toBeDefined();
    });

    it("복합 유니크 제약에서 동일 조합의 INSERT가 실패해야 한다", async () => {
      // 인덱스가 없으면 직접 생성 (이전 테스트 상태에 의존하지 않음)
      const indexes = await driver.getIndexes("composite_test");
      const hasIdx = (indexes as any[]).some(
        (idx: any) => idx.name === "uq_composite_ab",
      );
      if (!hasIdx) {
        await driver.addCompositeUniqueIndex(
          "composite_test",
          ["col_a", "col_b"],
          "uq_composite_ab",
        );
      }

      // 기존 데이터 정리 후 삽입
      await connector.query(
        "DELETE FROM \"composite_test\" WHERE \"col_a\" = 'x' AND \"col_b\" = 'y'",
      );
      await connector.query(
        "INSERT INTO \"composite_test\" (\"col_a\", \"col_b\") VALUES ('x', 'y')",
      );

      await expect(
        connector.query(
          "INSERT INTO \"composite_test\" (\"col_a\", \"col_b\") VALUES ('x', 'y')",
        ),
      ).rejects.toThrow();
    });

    it("복합 유니크 제약에서 다른 조합은 INSERT 성공해야 한다", async () => {
      await expect(
        connector.query(
          "INSERT INTO \"composite_test\" (\"col_a\", \"col_b\") VALUES ('x', 'z')",
        ),
      ).resolves.not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────
  // EXPLAIN QUERY PLAN
  // ─────────────────────────────────────────────────────────

  describe("EXPLAIN", () => {
    it("supportsExplain()이 true여야 한다", () => {
      expect(driver.supportsExplain()).toBe(true);
    });

    it("buildExplainSql로 EXPLAIN QUERY PLAN SQL을 생성할 수 있어야 한다", () => {
      const explainSql = driver.buildExplainSql(
        "SELECT * FROM \"ddl_test\"",
      );
      expect(explainSql).toContain("EXPLAIN QUERY PLAN");
    });

    it("EXPLAIN QUERY PLAN이 실행 가능해야 한다", async () => {
      const result = await connector.query(
        "EXPLAIN QUERY PLAN SELECT * FROM \"ddl_test\"",
      );
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // dropColumn (SQLite 3.35+)
  // ─────────────────────────────────────────────────────────

  describe("dropColumn", () => {
    it("dropColumn으로 컬럼을 삭제할 수 있어야 한다 (SQLite 3.35+)", async () => {
      // 먼저 extra 컬럼이 있는지 확인
      const hasBefore = await driver.hasColumn("ddl_test", "extra");
      if (!hasBefore) {
        await driver.addColumn("ddl_test", "extra", "TEXT");
      }

      await driver.dropColumn("ddl_test", "extra");

      const hasAfter = await driver.hasColumn("ddl_test", "extra");
      expect(hasAfter).toBe(false);
    });
  });
});
