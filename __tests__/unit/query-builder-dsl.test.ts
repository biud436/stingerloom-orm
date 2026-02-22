import { Conditions } from "../../src/core/Conditions";
import { RawQueryBuilderFactory } from "../../src/core/RawQueryBuilderFactory";

describe("Query Builder DSL 확장", () => {
  describe("leftJoin", () => {
    it("LEFT JOIN 쿼리를 생성해야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["u.id", "u.name", "p.title"])
        .from("users", "u")
        .leftJoin("posts", "p", Conditions.compareColumns("u.id", "=", "p.user_id"))
        .build();

      expect(query.sql).toBe(
        "SELECT u.id, u.name, p.title FROM users AS u LEFT JOIN posts AS p ON u.id = p.user_id",
      );
      expect(query.values).toEqual([]);
    });

    it("다중 leftJoin을 체이닝할 수 있어야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["u.id", "p.title", "c.content"])
        .from("users", "u")
        .leftJoin("posts", "p", Conditions.compareColumns("u.id", "=", "p.user_id"))
        .leftJoin("comments", "c", Conditions.compareColumns("p.id", "=", "c.post_id"))
        .build();

      expect(query.sql).toBe(
        "SELECT u.id, p.title, c.content " +
          "FROM users AS u " +
          "LEFT JOIN posts AS p ON u.id = p.user_id " +
          "LEFT JOIN comments AS c ON p.id = c.post_id",
      );
    });

    it("leftJoin과 where를 함께 사용할 수 있어야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select("*")
        .from("users", "u")
        .leftJoin("orders", "o", Conditions.compareColumns("u.id", "=", "o.user_id"))
        .where([Conditions.equals("u.status", "active")])
        .build();

      expect(query.sql).toBe(
        "SELECT * FROM users AS u " +
          "LEFT JOIN orders AS o ON u.id = o.user_id " +
          "WHERE u.status = ?",
      );
      expect(query.values).toEqual(["active"]);
    });
  });

  describe("innerJoin", () => {
    it("INNER JOIN 쿼리를 생성해야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["u.name", "d.name"])
        .from("users", "u")
        .innerJoin("departments", "d", Conditions.compareColumns("u.dept_id", "=", "d.id"))
        .build();

      expect(query.sql).toBe(
        "SELECT u.name, d.name FROM users AS u INNER JOIN departments AS d ON u.dept_id = d.id",
      );
      expect(query.values).toEqual([]);
    });

    it("innerJoin과 leftJoin을 혼합할 수 있어야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["u.name", "d.name", "p.title"])
        .from("users", "u")
        .innerJoin("departments", "d", Conditions.compareColumns("u.dept_id", "=", "d.id"))
        .leftJoin("posts", "p", Conditions.compareColumns("u.id", "=", "p.user_id"))
        .build();

      expect(query.sql).toBe(
        "SELECT u.name, d.name, p.title " +
          "FROM users AS u " +
          "INNER JOIN departments AS d ON u.dept_id = d.id " +
          "LEFT JOIN posts AS p ON u.id = p.user_id",
      );
    });
  });

  describe("rightJoin", () => {
    it("RIGHT JOIN 쿼리를 생성해야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["e.name", "d.name"])
        .from("employees", "e")
        .rightJoin("departments", "d", Conditions.compareColumns("e.dept_id", "=", "d.id"))
        .build();

      expect(query.sql).toBe(
        "SELECT e.name, d.name FROM employees AS e RIGHT JOIN departments AS d ON e.dept_id = d.id",
      );
    });
  });

  describe("offset", () => {
    it("standalone OFFSET 절을 생성해야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select("*")
        .from("users")
        .limit(10)
        .offset(20)
        .build();

      expect(query.sql).toBe("SELECT * FROM users LIMIT ? OFFSET ?");
      expect(query.values).toEqual([10, 20]);
    });

    it("offset만 사용할 수 있어야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select("*")
        .from("users")
        .offset(5)
        .build();

      expect(query.sql).toBe("SELECT * FROM users OFFSET ?");
      expect(query.values).toEqual([5]);
    });

    it("offset 0을 올바르게 처리해야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select("*")
        .from("users")
        .limit(10)
        .offset(0)
        .build();

      expect(query.sql).toBe("SELECT * FROM users LIMIT ? OFFSET ?");
      expect(query.values).toEqual([10, 0]);
    });
  });

  describe("전체 체이닝", () => {
    it("select, from, innerJoin, where, groupBy, having, orderBy, limit, offset을 체이닝해야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select([
          "d.name",
          Conditions.count("e.id").sql + " as emp_count",
          Conditions.avg("e.salary").sql + " as avg_salary",
        ])
        .from("departments", "d")
        .innerJoin("employees", "e", Conditions.compareColumns("d.id", "=", "e.dept_id"))
        .where([Conditions.equals("d.active", true)])
        .groupBy(["d.name"])
        .having([Conditions.gt(Conditions.count("e.id"), 5)])
        .orderBy([{ column: "avg_salary", direction: "DESC" }])
        .limit(10)
        .offset(20)
        .build();

      const expectedSql = [
        "SELECT d.name, COUNT(e.id) as emp_count, AVG(e.salary) as avg_salary",
        "FROM departments AS d",
        "INNER JOIN employees AS e ON d.id = e.dept_id",
        "WHERE d.active = ?",
        "GROUP BY d.name",
        "HAVING COUNT(e.id) > ?",
        "ORDER BY avg_salary DESC",
        "LIMIT ?",
        "OFFSET ?",
      ].join(" ");

      expect(query.sql).toBe(expectedSql);
      expect(query.values).toEqual([true, 5, 10, 20]);
    });

    it("leftJoin과 where, orderBy, limit을 체이닝해야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select(["u.id", "u.name", "o.total"])
        .from("users", "u")
        .leftJoin("orders", "o", Conditions.compareColumns("u.id", "=", "o.user_id"))
        .where([
          Conditions.gte("o.total", 100),
          Conditions.equals("u.status", "active"),
        ])
        .orderBy([
          { column: "o.total", direction: "DESC" },
          { column: "u.name", direction: "ASC" },
        ])
        .limit(25)
        .build();

      const expectedSql = [
        "SELECT u.id, u.name, o.total",
        "FROM users AS u",
        "LEFT JOIN orders AS o ON u.id = o.user_id",
        "WHERE o.total >= ? AND u.status = ?",
        "ORDER BY o.total DESC, u.name ASC",
        "LIMIT ?",
      ].join(" ");

      expect(query.sql).toBe(expectedSql);
      expect(query.values).toEqual([100, "active", 25]);
    });

    it("다중 join과 groupBy, having을 체이닝해야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .select([
          "c.name",
          Conditions.sum("oi.quantity").sql + " as total_qty",
        ])
        .from("customers", "c")
        .innerJoin("orders", "o", Conditions.compareColumns("c.id", "=", "o.customer_id"))
        .innerJoin("order_items", "oi", Conditions.compareColumns("o.id", "=", "oi.order_id"))
        .where([Conditions.gte("o.created_at", "2024-01-01")])
        .groupBy(["c.name"])
        .having([Conditions.gt(Conditions.sum("oi.quantity"), 50)])
        .orderBy([{ column: "total_qty", direction: "DESC" }])
        .build();

      const expectedSql = [
        "SELECT c.name, SUM(oi.quantity) as total_qty",
        "FROM customers AS c",
        "INNER JOIN orders AS o ON c.id = o.customer_id",
        "INNER JOIN order_items AS oi ON o.id = oi.order_id",
        "WHERE o.created_at >= ?",
        "GROUP BY c.name",
        "HAVING SUM(oi.quantity) > ?",
        "ORDER BY total_qty DESC",
      ].join(" ");

      expect(query.sql).toBe(expectedSql);
      expect(query.values).toEqual(["2024-01-01", 50]);
    });
  });

  describe("서브쿼리와 DSL 편의 메서드 조합", () => {
    it("leftJoin에서 서브쿼리를 사용할 수 있어야 함", () => {
      const subquery = RawQueryBuilderFactory.subquery()
        .select(["user_id", Conditions.count("id").sql + " as order_count"])
        .from("orders")
        .groupBy(["user_id"])
        .as("oc");

      const query = RawQueryBuilderFactory.create()
        .select(["u.name", "oc.order_count"])
        .from("users", "u")
        .leftJoin(subquery.sql, "oc", Conditions.compareColumns("u.id", "=", "oc.user_id"))
        .orderBy([{ column: "oc.order_count", direction: "DESC" }])
        .limit(10)
        .build();

      expect(query.sql).toContain("LEFT JOIN (SELECT user_id, COUNT(id) as order_count");
      expect(query.sql).toContain("FROM orders");
      expect(query.sql).toContain("GROUP BY user_id) AS oc");
      expect(query.sql).toContain("ON u.id = oc.user_id");
      expect(query.sql).toContain("ORDER BY oc.order_count DESC");
      expect(query.sql).toContain("LIMIT ?");
    });

    it("innerJoin에서 서브쿼리를 사용할 수 있어야 함", () => {
      const subquery = RawQueryBuilderFactory.subquery()
        .select(["dept_id", Conditions.avg("salary").sql + " as avg_sal"])
        .from("employees")
        .groupBy(["dept_id"])
        .as("ds");

      const query = RawQueryBuilderFactory.create()
        .select(["d.name", "ds.avg_sal"])
        .from("departments", "d")
        .innerJoin(subquery.sql, "ds", Conditions.compareColumns("d.id", "=", "ds.dept_id"))
        .where([Conditions.gt("ds.avg_sal", 60000)])
        .build();

      expect(query.sql).toContain("INNER JOIN (SELECT dept_id, AVG(salary) as avg_sal");
      expect(query.sql).toContain("WHERE ds.avg_sal > ?");
      expect(query.values).toEqual([60000]);
    });
  });

  describe("DB별 limit/offset 동작", () => {
    it("MySQL에서 limit과 offset을 독립적으로 사용할 수 있어야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .setDatabaseType("mysql")
        .select("*")
        .from("users")
        .limit(10)
        .offset(5)
        .build();

      expect(query.sql).toBe("SELECT * FROM users LIMIT ? OFFSET ?");
      expect(query.values).toEqual([10, 5]);
    });

    it("PostgreSQL에서 limit과 offset을 독립적으로 사용할 수 있어야 함", () => {
      const query = RawQueryBuilderFactory.create()
        .setDatabaseType("postgresql")
        .select("*")
        .from("users")
        .limit(10)
        .offset(5)
        .build();

      expect(query.sql).toBe("SELECT * FROM users LIMIT ? OFFSET ?");
      expect(query.values).toEqual([10, 5]);
    });
  });
});
