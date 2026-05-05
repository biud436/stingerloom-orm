import {
  createDialectExpression,
  resetDialectExpressionCache,
} from "../../src/dialects/DialectExpression";
import { PostgresExpression } from "../../src/dialects/expression/PostgresExpression";
import { MySqlExpression } from "../../src/dialects/expression/MySqlExpression";
import { SqliteExpression } from "../../src/dialects/expression/SqliteExpression";
import { OrmError } from "../../src/errors/OrmError";

afterEach(() => {
  resetDialectExpressionCache();
});

describe("DialectExpression", () => {
  describe("PostgresExpression", () => {
    const expr = new PostgresExpression();

    it("dialect is postgres", () => {
      expect(expr.dialect).toBe("postgres");
    });

    it("ilike generates native ILIKE", () => {
      const result = expr.ilike('"name"', "%alice%");
      expect(result.sql).toContain("ILIKE");
      expect(result.values).toContain("%alice%");
    });

    it("fullTextSearch generates tsvector/tsquery", () => {
      const result = expr.fullTextSearch('"content"', "hello world");
      expect(result.sql).toContain("to_tsvector");
      expect(result.sql).toContain("plainto_tsquery");
      expect(result.values).toContain("hello world");
    });

    it("fullTextSearch defaults to english language", () => {
      const result = expr.fullTextSearch('"content"', "test");
      expect(result.values).toContain("english");
    });

    it("fullTextSearch accepts custom language", () => {
      const result = expr.fullTextSearch('"content"', "test", "korean");
      expect(result.values).toContain("korean");
      expect(result.values).not.toContain("english");
    });

    it("fullTextSearch accepts options object with language", () => {
      const result = expr.fullTextSearch('"content"', "test", { language: "korean" });
      expect(result.values).toContain("korean");
    });

    it("fullTextSearch composes multiple columns via COALESCE", () => {
      const result = expr.fullTextSearch(
        ['i."title"', 'i."description"'],
        "hello",
      );
      expect(result.sql).toBe(
        "to_tsvector(?, COALESCE(i.\"title\", '') || ' ' || COALESCE(i.\"description\", '')) @@ plainto_tsquery(?, ?)",
      );
      expect(result.values).toEqual(["english", "english", "hello"]);
    });
  });

  describe("MySqlExpression", () => {
    const expr = new MySqlExpression();

    it("dialect is mysql", () => {
      expect(expr.dialect).toBe("mysql");
    });

    it("ilike generates LIKE (not ILIKE)", () => {
      const result = expr.ilike("`name`", "%alice%");
      expect(result.sql).toContain("LIKE");
      expect(result.sql).not.toContain("ILIKE");
      expect(result.values).toContain("%alice%");
    });

    it("fullTextSearch generates MATCH AGAINST", () => {
      const result = expr.fullTextSearch("`content`", "hello world");
      expect(result.sql).toContain("MATCH");
      expect(result.sql).toContain("AGAINST");
      expect(result.sql).toContain("BOOLEAN MODE");
      expect(result.values).toContain("hello world");
    });

    it("fullTextSearch supports natural language mode", () => {
      const result = expr.fullTextSearch("`title`", "hello", { mode: "natural" });
      expect(result.sql).toBe("MATCH(`title`) AGAINST(? IN NATURAL LANGUAGE MODE)");
    });

    it("fullTextSearch accepts multiple columns", () => {
      const result = expr.fullTextSearch(
        ["i.`title`", "i.`body`"],
        "hello",
        { mode: "natural" },
      );
      expect(result.sql).toBe(
        "MATCH(i.`title`, i.`body`) AGAINST(? IN NATURAL LANGUAGE MODE)",
      );
    });
  });

  describe("SqliteExpression", () => {
    const expr = new SqliteExpression();

    it("dialect is sqlite", () => {
      expect(expr.dialect).toBe("sqlite");
    });

    it("ilike generates LIKE (not ILIKE)", () => {
      const result = expr.ilike('"name"', "%alice%");
      expect(result.sql).toContain("LIKE");
      expect(result.sql).not.toContain("ILIKE");
      expect(result.values).toContain("%alice%");
    });

    it("fullTextSearch throws OrmError", () => {
      expect(() => expr.fullTextSearch('"content"', "test")).toThrow(OrmError);
      expect(() => expr.fullTextSearch('"content"', "test")).toThrow(
        /not supported for SQLite/,
      );
    });
  });

  describe("createDialectExpression", () => {
    it("returns PostgresExpression for postgres", () => {
      const expr = createDialectExpression("postgres");
      expect(expr).toBeInstanceOf(PostgresExpression);
      expect(expr.dialect).toBe("postgres");
    });

    it("returns MySqlExpression for mysql", () => {
      const expr = createDialectExpression("mysql");
      expect(expr).toBeInstanceOf(MySqlExpression);
      expect(expr.dialect).toBe("mysql");
    });

    it("returns SqliteExpression for sqlite", () => {
      const expr = createDialectExpression("sqlite");
      expect(expr).toBeInstanceOf(SqliteExpression);
      expect(expr.dialect).toBe("sqlite");
    });

    it("caches instances (same reference for repeated calls)", () => {
      const a = createDialectExpression("postgres");
      const b = createDialectExpression("postgres");
      expect(a).toBe(b);
    });

    it("different dialects return different instances", () => {
      const pg = createDialectExpression("postgres");
      const mysql = createDialectExpression("mysql");
      const sqlite = createDialectExpression("sqlite");
      expect(pg).not.toBe(mysql);
      expect(mysql).not.toBe(sqlite);
    });
  });
});
