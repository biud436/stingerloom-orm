import "reflect-metadata";
import sql from "sql-template-tag";
import { RawQueryBuilderFactory } from "../../src/core/RawQueryBuilderFactory";
import { Conditions } from "../../src/core/Conditions";
/* eslint-disable @typescript-eslint/no-explicit-any */

describe("GROUP BY / HAVING", () => {
  describe("RawQueryBuilder.groupBy()", () => {
    it("단일 컬럼으로 GROUP BY를 생성해야 한다", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["department", "COUNT(*) AS cnt"])
        .from("employees")
        .where([])
        .groupBy(["department"])
        .build();

      expect(query.sql).toBe(
        "SELECT department, COUNT(*) AS cnt FROM employees GROUP BY department",
      );
    });

    it("복수 컬럼으로 GROUP BY를 생성해야 한다", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["department", "role", "COUNT(*) AS cnt"])
        .from("employees")
        .where([])
        .groupBy(["department", "role"])
        .build();

      expect(query.sql).toBe(
        "SELECT department, role, COUNT(*) AS cnt FROM employees GROUP BY department, role",
      );
    });

    it("빈 배열이면 GROUP BY를 생략해야 한다", () => {
      const query = RawQueryBuilderFactory.create()
        .select("*")
        .from("employees")
        .where([])
        .groupBy([])
        .build();

      expect(query.sql).toBe("SELECT * FROM employees");
    });
  });

  describe("RawQueryBuilder.having()", () => {
    it("HAVING 조건을 생성해야 한다", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["department", "COUNT(*) AS cnt"])
        .from("employees")
        .where([])
        .groupBy(["department"])
        .having([Conditions.gt("COUNT(*)", 5)])
        .build();

      expect(query.sql).toBe(
        "SELECT department, COUNT(*) AS cnt FROM employees GROUP BY department HAVING COUNT(*) > ?",
      );
      expect(query.values).toEqual([5]);
    });

    it("복수 HAVING 조건을 AND로 결합해야 한다", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["department", "COUNT(*) AS cnt", "AVG(salary) AS avg_sal"])
        .from("employees")
        .where([])
        .groupBy(["department"])
        .having([
          Conditions.gt("COUNT(*)", 3),
          Conditions.gt("AVG(salary)", 50000),
        ])
        .build();

      expect(query.sql).toBe(
        "SELECT department, COUNT(*) AS cnt, AVG(salary) AS avg_sal " +
          "FROM employees " +
          "GROUP BY department " +
          "HAVING COUNT(*) > ? AND AVG(salary) > ?",
      );
      expect(query.values).toEqual([3, 50000]);
    });

    it("빈 배열이면 HAVING을 생략해야 한다", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["department", "COUNT(*) AS cnt"])
        .from("employees")
        .where([])
        .groupBy(["department"])
        .having([])
        .build();

      expect(query.sql).toBe(
        "SELECT department, COUNT(*) AS cnt FROM employees GROUP BY department",
      );
    });
  });

  describe("GROUP BY + HAVING + ORDER BY + LIMIT 복합", () => {
    it("올바른 SQL 순서로 생성해야 한다", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["department", "COUNT(*) AS cnt"])
        .from("employees")
        .where([Conditions.equals("status", "active")])
        .groupBy(["department"])
        .having([Conditions.gt("COUNT(*)", 2)])
        .orderBy([{ column: "cnt", direction: "DESC" }])
        .limit(10)
        .build();

      expect(query.sql).toBe(
        "SELECT department, COUNT(*) AS cnt FROM employees " +
          "WHERE status = ? " +
          "GROUP BY department " +
          "HAVING COUNT(*) > ? " +
          "ORDER BY cnt DESC " +
          "LIMIT ?",
      );
      expect(query.values).toEqual(["active", 2, 10]);
    });

    it("JOIN + GROUP BY + HAVING을 함께 사용해야 한다", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["u.name", "COUNT(o.id) AS order_count"])
        .from("users", "u")
        .leftJoin(
          "orders",
          "o",
          Conditions.compareColumns("u.id", "=", "o.user_id"),
        )
        .where([])
        .groupBy(["u.name"])
        .having([Conditions.gt("COUNT(o.id)", 3)])
        .orderBy([{ column: "order_count", direction: "DESC" }])
        .build();

      expect(query.sql).toBe(
        "SELECT u.name, COUNT(o.id) AS order_count " +
          "FROM users AS u " +
          "LEFT JOIN orders AS o ON u.id = o.user_id " +
          "" +
          "GROUP BY u.name " +
          "HAVING COUNT(o.id) > ? " +
          "ORDER BY order_count DESC",
      );
      expect(query.values).toEqual([3]);
    });
  });

  describe("SQL injection 방지", () => {
    it("groupBy 컬럼이 escapeIdentifier를 통해 래핑되어야 한다", () => {
      // RawQueryBuilder는 raw()로 컬럼을 삽입하므로, 호출자가 래핑한 컬럼을 전달해야 함
      // EntityManager에서는 this.wrap()으로 래핑하여 전달
      const wrappedCol = '`department`';
      const query = RawQueryBuilderFactory.create()
        .select([`${wrappedCol}`, "COUNT(*) AS cnt"])
        .from("`employees`")
        .where([])
        .groupBy([wrappedCol])
        .build();

      expect(query.sql).toContain("GROUP BY `department`");
    });

    it("having 조건 값은 파라미터 바인딩을 사용해야 한다", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["department", "COUNT(*) AS cnt"])
        .from("employees")
        .where([])
        .groupBy(["department"])
        .having([Conditions.gt("COUNT(*)", 5)])
        .build();

      // 값이 ? 파라미터로 바인딩됨
      expect(query.sql).toContain("HAVING COUNT(*) > ?");
      expect(query.values).toContain(5);
    });
  });

});
