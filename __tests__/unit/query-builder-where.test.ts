/* eslint-disable @typescript-eslint/no-explicit-any */
import sql from "sql-template-tag";
import { RawQueryBuilder } from "../../src/core/RawQueryBuilder";
import { Conditions } from "../../src/core/Conditions";

describe("Query Builder WHERE 개선", () => {
  let qb: RawQueryBuilder;

  beforeEach(() => {
    qb = RawQueryBuilder.create();
  });

  describe("andWhere()", () => {
    it("WHERE 절 뒤에 AND 조건을 추가해야 함", () => {
      const result = qb
        .select("*")
        .from('"users"')
        .where([Conditions.equals('"id"', 1)])
        .andWhere(Conditions.equals('"active"', true))
        .build();

      expect(result.sql).toContain("WHERE");
      expect(result.sql).toContain("AND");
      expect(result.sql).toMatch(/"id"\s*=\s*\?/);
      expect(result.sql).toMatch(/"active"\s*=\s*\?/);
    });

    it("여러 andWhere를 체이닝할 수 있어야 함", () => {
      const result = qb
        .select("*")
        .from('"products"')
        .where([Conditions.gt('"price"', 0)])
        .andWhere(Conditions.lt('"price"', 100))
        .andWhere(Conditions.equals('"category"', "electronics"))
        .build();

      // Should have two AND segments
      const andCount = (result.sql.match(/AND/g) || []).length;
      expect(andCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("orWhere()", () => {
    it("WHERE 절 뒤에 OR 조건을 추가해야 함", () => {
      const result = qb
        .select("*")
        .from('"users"')
        .where([Conditions.equals('"role"', "admin")])
        .orWhere(Conditions.equals('"role"', "superadmin"))
        .build();

      expect(result.sql).toContain("WHERE");
      expect(result.sql).toContain("OR");
    });

    it("andWhere와 orWhere를 혼합할 수 있어야 함", () => {
      const result = qb
        .select("*")
        .from('"orders"')
        .where([Conditions.equals('"status"', "pending")])
        .orWhere(Conditions.equals('"status"', "processing"))
        .andWhere(Conditions.gt('"total"', 50))
        .build();

      expect(result.sql).toContain("OR");
      expect(result.sql).toContain("AND");
    });
  });

  describe("whereIn()", () => {
    it("WHERE col IN (...) 조건을 추가해야 함", () => {
      const result = qb
        .select("*")
        .from('"users"')
        .where([])
        .whereIn('"id"', [1, 2, 3])
        .build();

      expect(result.sql).toContain("IN");
      expect(result.values).toContain(1);
      expect(result.values).toContain(2);
      expect(result.values).toContain(3);
    });

    it("문자열 값 배열을 지원해야 함", () => {
      const result = qb
        .select("*")
        .from('"products"')
        .where([])
        .whereIn('"category"', ["A", "B", "C"])
        .build();

      expect(result.sql).toContain("IN");
      expect(result.values).toContain("A");
      expect(result.values).toContain("B");
      expect(result.values).toContain("C");
    });
  });

  describe("whereNotIn()", () => {
    it("WHERE col NOT IN (...) 조건을 추가해야 함", () => {
      const result = qb
        .select("*")
        .from('"users"')
        .where([])
        .whereNotIn('"status"', ["banned", "deleted"])
        .build();

      expect(result.sql).toContain("NOT IN");
      expect(result.values).toContain("banned");
      expect(result.values).toContain("deleted");
    });
  });

  describe("whereNull()", () => {
    it("WHERE col IS NULL 조건을 추가해야 함", () => {
      const result = qb
        .select("*")
        .from('"users"')
        .where([])
        .whereNull('"deleted_at"')
        .build();

      expect(result.sql).toContain("IS NULL");
      expect(result.sql).toContain('"deleted_at"');
    });
  });

  describe("whereNotNull()", () => {
    it("WHERE col IS NOT NULL 조건을 추가해야 함", () => {
      const result = qb
        .select("*")
        .from('"users"')
        .where([])
        .whereNotNull('"email"')
        .build();

      expect(result.sql).toContain("IS NOT NULL");
      expect(result.sql).toContain('"email"');
    });
  });

  describe("whereBetween()", () => {
    it("WHERE col BETWEEN min AND max 조건을 추가해야 함", () => {
      const result = qb
        .select("*")
        .from('"products"')
        .where([])
        .whereBetween('"price"', 10, 100)
        .build();

      expect(result.sql).toContain("BETWEEN");
      expect(result.values).toContain(10);
      expect(result.values).toContain(100);
    });

    it("날짜 범위 쿼리를 지원해야 함", () => {
      const result = qb
        .select("*")
        .from('"events"')
        .where([])
        .whereBetween('"created_at"', "2026-01-01", "2026-12-31")
        .build();

      expect(result.sql).toContain("BETWEEN");
      expect(result.values).toContain("2026-01-01");
      expect(result.values).toContain("2026-12-31");
    });
  });

  describe("복합 쿼리 체이닝", () => {
    it("여러 WHERE 편의 메서드를 조합할 수 있어야 함", () => {
      const result = qb
        .select(['"id"', '"name"', '"price"'])
        .from('"products"')
        .where([Conditions.equals('"active"', true)])
        .whereIn('"category"', ["A", "B"])
        .whereNotNull('"description"')
        .whereBetween('"price"', 10, 1000)
        .orderBy([{ column: '"price"', direction: "ASC" }])
        .limit(20)
        .build();

      expect(result.sql).toContain("SELECT");
      expect(result.sql).toContain("FROM");
      expect(result.sql).toContain("WHERE");
      expect(result.sql).toContain("IN");
      expect(result.sql).toContain("IS NOT NULL");
      expect(result.sql).toContain("BETWEEN");
      expect(result.sql).toContain("ORDER BY");
      expect(result.sql).toContain("LIMIT");
    });

    it("orWhere로 복합 필터를 구성할 수 있어야 함", () => {
      const result = qb
        .select("*")
        .from('"logs"')
        .where([Conditions.equals('"level"', "error")])
        .orWhere(Conditions.equals('"level"', "fatal"))
        .whereNotNull('"message"')
        .build();

      expect(result.sql).toContain("WHERE");
      expect(result.sql).toContain("OR");
      expect(result.sql).toContain("IS NOT NULL");
    });

    it("whereNull과 whereNotNull을 함께 사용할 수 있어야 함", () => {
      const result = qb
        .select("*")
        .from('"users"')
        .where([])
        .whereNull('"deleted_at"')
        .whereNotNull('"email"')
        .build();

      expect(result.sql).toContain("IS NULL");
      expect(result.sql).toContain("IS NOT NULL");
    });
  });

  describe("파라미터 바인딩 안전성", () => {
    it("whereIn 값이 파라미터로 바인딩되어야 함 (SQL injection 방지)", () => {
      const result = qb
        .select("*")
        .from('"users"')
        .where([])
        .whereIn('"name"', ["Robert'; DROP TABLE users;--", "Alice"])
        .build();

      // Values should be parameterized, not embedded in SQL
      expect(result.values).toContain("Robert'; DROP TABLE users;--");
      expect(result.sql).not.toContain("DROP TABLE");
    });

    it("whereBetween 값이 파라미터로 바인딩되어야 함", () => {
      const result = qb
        .select("*")
        .from('"products"')
        .where([])
        .whereBetween('"price"', 0, 999)
        .build();

      expect(result.values).toContain(0);
      expect(result.values).toContain(999);
    });
  });
});
