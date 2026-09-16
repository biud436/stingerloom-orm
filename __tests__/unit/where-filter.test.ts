import "reflect-metadata";
import {
  resolveWhereClause,
  isFilterObject,
  escapeLikePattern,
} from "../../src/core/WhereResolver";
import { WhereClause } from "../../src/dialects/FindOption";
import sql from "sql-template-tag";
import { Conditions } from "../../src/core/Conditions";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import {
  assertWhereNotVacuous,
  findVacuousWhere,
} from "../../src/core/ColumnNameValidator";

// Test entity type
interface User {
  id: number;
  name: string;
  email: string;
  age: number;
  status: string;
  score: number;
  bio: string | null;
  createdAt: Date;
}

// Simple wrap function for testing (MySQL backtick style)
const wrap = (n: string) => `\`${n}\``;

function resolve(where: WhereClause<User> | WhereClause<User>[] | undefined) {
  return resolveWhereClause(where, { wrapColumn: wrap });
}

function resolveSingle(where: WhereClause<User>) {
  const results = resolve(where);
  expect(results.length).toBeGreaterThan(0);
  return results[0];
}

describe("WhereResolver", () => {
  describe("isFilterObject", () => {
    it("should detect filter objects", () => {
      expect(isFilterObject({ gt: 18 })).toBe(true);
      expect(isFilterObject({ gt: 18, lte: 65 })).toBe(true);
      expect(isFilterObject({ like: "%test%" })).toBe(true);
      expect(isFilterObject({ in: [1, 2, 3] })).toBe(true);
      expect(isFilterObject({ isNull: true })).toBe(true);
      expect(isFilterObject({ contains: "alice" })).toBe(true);
      expect(isFilterObject({ not: "admin" })).toBe(true);
    });

    it("should reject non-filter objects", () => {
      expect(isFilterObject(null)).toBe(false);
      expect(isFilterObject(undefined)).toBe(false);
      expect(isFilterObject(42)).toBe(false);
      expect(isFilterObject("text")).toBe(false);
      expect(isFilterObject([1, 2])).toBe(false);
      expect(isFilterObject({})).toBe(false);
      expect(isFilterObject({ name: "Alice" })).toBe(false);
      expect(isFilterObject({ gt: 18, name: "mixed" })).toBe(false);
    });

    it("should reject Sql objects", () => {
      const sqlObj = sql`age > ${18}`;
      expect(isFilterObject(sqlObj)).toBe(false);
    });
  });

  describe("escapeLikePattern", () => {
    it("should escape % and _ characters", () => {
      expect(escapeLikePattern("50%")).toBe("50\\%");
      expect(escapeLikePattern("user_name")).toBe("user\\_name");
      expect(escapeLikePattern("test\\value")).toBe("test\\\\value");
      expect(escapeLikePattern("normal")).toBe("normal");
    });
  });

  describe("basic equality (backward compat)", () => {
    it("should handle plain value as equals", () => {
      const result = resolveSingle({ name: "Alice" });
      expect(result.sql).toContain("`name` =");
      expect(result.values).toContain("Alice");
    });

    it("should handle array as IN", () => {
      const result = resolveSingle({ status: ["active", "pending"] as any });
      expect(result.sql).toContain("`status` IN");
      expect(result.values).toEqual(["active", "pending"]);
    });

    it("should handle null as IS NULL", () => {
      const result = resolveSingle({ bio: null });
      expect(result.sql).toContain("`bio` IS NULL");
    });

    it("should skip undefined values", () => {
      const results = resolve({ name: undefined as any });
      expect(results).toHaveLength(0);
    });

    it("should handle Sql objects (backward compat)", () => {
      const sqlObj = Conditions.gt("`age`", 18);
      const result = resolveSingle({ age: sqlObj as any });
      expect(result.sql).toContain("`age` >");
      expect(result.values).toContain(18);
    });
  });

  describe("comparison operators", () => {
    it("gt: greater than", () => {
      const result = resolveSingle({ age: { gt: 18 } });
      expect(result.sql).toContain("`age` >");
      expect(result.values).toContain(18);
    });

    it("gte: greater than or equal", () => {
      const result = resolveSingle({ age: { gte: 18 } });
      expect(result.sql).toContain("`age` >=");
      expect(result.values).toContain(18);
    });

    it("lt: less than", () => {
      const result = resolveSingle({ age: { lt: 65 } });
      expect(result.sql).toContain("`age` <");
      expect(result.values).toContain(65);
    });

    it("lte: less than or equal", () => {
      const result = resolveSingle({ age: { lte: 65 } });
      expect(result.sql).toContain("`age` <=");
      expect(result.values).toContain(65);
    });

    it("eq: explicit equals", () => {
      const result = resolveSingle({ age: { eq: 25 } });
      expect(result.sql).toContain("`age` =");
      expect(result.values).toContain(25);
    });

    it("ne: not equals", () => {
      const result = resolveSingle({ status: { ne: "deleted" } });
      expect(result.sql).toContain("`status` !=");
      expect(result.values).toContain("deleted");
    });

    it("eq: null → IS NULL (not `= NULL`)", () => {
      const result = resolveSingle({ bio: { eq: null } as any });
      expect(result.sql).toContain("`bio` IS NULL");
      expect(result.sql).not.toContain("=");
      expect(result.values).toHaveLength(0);
    });

    it("ne: null → IS NOT NULL (not `!= NULL`)", () => {
      const result = resolveSingle({ bio: { ne: null } as any });
      expect(result.sql).toContain("`bio` IS NOT NULL");
      expect(result.sql).not.toContain("!=");
      expect(result.values).toHaveLength(0);
    });

    it("compound: gt + lte on same field", () => {
      const result = resolveSingle({ age: { gt: 18, lte: 65 } });
      expect(result.sql).toContain("`age` >");
      expect(result.sql).toContain("`age` <=");
      expect(result.sql).toContain("AND");
      expect(result.values).toContain(18);
      expect(result.values).toContain(65);
    });
  });

  describe("set operators", () => {
    it("in: array of values", () => {
      const result = resolveSingle({ status: { in: ["active", "pending"] } });
      expect(result.sql).toContain("`status` IN");
      expect(result.values).toEqual(["active", "pending"]);
    });

    it("notIn: array of values", () => {
      const result = resolveSingle({ status: { notIn: ["banned"] } });
      expect(result.sql).toContain("`status` NOT IN");
      expect(result.values).toEqual(["banned"]);
    });

    it("between: range", () => {
      const result = resolveSingle({ score: { between: [60, 100] } });
      expect(result.sql).toContain("`score` BETWEEN");
      expect(result.values).toEqual([60, 100]);
    });
  });

  describe("string operators", () => {
    it("like: raw pattern", () => {
      const result = resolveSingle({ name: { like: "%alice%" } });
      expect(result.sql).toContain("`name` LIKE");
      expect(result.values).toContain("%alice%");
    });

    it("notLike: raw pattern", () => {
      const result = resolveSingle({ name: { notLike: "%test%" } });
      expect(result.sql).toContain("`name` NOT LIKE");
      expect(result.values).toContain("%test%");
    });

    it("ilike: case-insensitive", () => {
      const result = resolveSingle({ name: { ilike: "%alice%" } });
      expect(result.sql).toContain("`name` ILIKE");
      expect(result.values).toContain("%alice%");
    });

    it("contains: auto-wrapped with %", () => {
      const result = resolveSingle({ name: { contains: "alice" } });
      expect(result.sql).toContain("`name` LIKE");
      expect(result.values).toContain("%alice%");
    });

    it("contains: escapes % and _ in value", () => {
      const result = resolveSingle({ name: { contains: "50%" } });
      expect(result.values).toContain("%50\\%%");
    });

    it("startsWith: auto-wrapped with trailing %", () => {
      const result = resolveSingle({ name: { startsWith: "alice" } });
      expect(result.sql).toContain("`name` LIKE");
      expect(result.values).toContain("alice%");
    });

    it("endsWith: auto-wrapped with leading %", () => {
      const result = resolveSingle({ email: { endsWith: "@gmail.com" } });
      expect(result.sql).toContain("`email` LIKE");
      expect(result.values).toContain("%@gmail.com");
    });
  });

  describe("null operators", () => {
    it("isNull: true → IS NULL", () => {
      const result = resolveSingle({ bio: { isNull: true } as any });
      expect(result.sql).toContain("`bio` IS NULL");
    });

    it("isNull: false → IS NOT NULL", () => {
      const result = resolveSingle({ bio: { isNull: false } as any });
      expect(result.sql).toContain("`bio` IS NOT NULL");
    });
  });

  describe("not operator", () => {
    it("not: plain value → ne", () => {
      const result = resolveSingle({ status: { not: "admin" } });
      expect(result.sql).toContain("`status` !=");
      expect(result.values).toContain("admin");
    });

    it("not: null → IS NOT NULL", () => {
      const result = resolveSingle({ bio: { not: null } as any });
      expect(result.sql).toContain("`bio` IS NOT NULL");
    });

    it("not: nested filter → NOT (condition)", () => {
      const result = resolveSingle({ age: { not: { gt: 18 } } as any });
      expect(result.sql).toContain("NOT (");
      expect(result.sql).toContain("`age` >");
      expect(result.values).toContain(18);
    });
  });

  describe("OR combinator", () => {
    it("should combine clauses with OR", () => {
      const results = resolve({
        OR: [{ name: "Alice" }, { name: "Bob" }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].sql).toContain("OR");
    });

    it("should handle OR with filter operators", () => {
      const results = resolve({
        OR: [
          { status: "active" },
          { age: { gt: 30 } },
        ],
      });
      expect(results).toHaveLength(1);
      expect(results[0].sql).toContain("OR");
    });
  });

  describe("AND combinator", () => {
    it("should explicitly AND clauses", () => {
      const results = resolve({
        AND: [{ name: "Alice" }, { status: "active" }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].sql).toContain("AND");
    });
  });

  describe("NOT combinator", () => {
    it("should negate a where clause", () => {
      const results = resolve({
        NOT: { status: "banned" },
      });
      expect(results).toHaveLength(1);
      expect(results[0].sql).toContain("NOT (");
      expect(results[0].values).toContain("banned");
    });
  });

  describe("array where (OR shorthand)", () => {
    it("should OR-combine array elements", () => {
      const results = resolve([
        { name: "Alice", status: "active" },
        { age: { gt: 30 } },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].sql).toContain("OR");
    });

    it("single element array returns conditions directly", () => {
      const results = resolve([{ name: "Alice" }]);
      expect(results).toHaveLength(1);
      expect(results[0].sql).toContain("`name` =");
    });
  });

  describe("qualified columns (eager joins)", () => {
    it("should prefix with table name", () => {
      const results = resolveWhereClause<User>(
        { name: "Alice" },
        { wrapColumn: wrap, qualified: true, tableName: "users" },
      );
      expect(results).toHaveLength(1);
      expect(results[0].sql).toContain("`users`.`name` =");
    });
  });

  describe("mixed conditions", () => {
    it("should handle complex where with multiple fields and operators", () => {
      const results = resolve({
        age: { gt: 18, lte: 65 },
        name: { contains: "alice" },
        status: { in: ["active", "pending"] },
        bio: null,
      });
      // age produces 1 (AND-combined), name 1, status 1, bio 1
      expect(results.length).toBe(4);
    });

    it("should handle field conditions mixed with OR", () => {
      const results = resolve({
        status: "active",
        OR: [
          { age: { gt: 30 } },
          { score: { gte: 90 } },
        ],
      });
      // status = 1 condition, OR = 1 condition
      expect(results.length).toBe(2);
    });
  });

  describe("doc example: status + NOT + AND combo", () => {
    it("should handle mixed field + NOT + AND conditions", () => {
      const results = resolve({
        status: "active",
        NOT: { status: "banned" },
        AND: [
          { age: { gte: 18 } },
          { age: { lte: 65 } },
        ],
      });
      // status = 1, NOT = 1, AND = 1
      expect(results.length).toBe(3);

      const sqlText = results.map((r) => r.sql).join(" ");
      expect(sqlText).toContain("`status` =");
      expect(sqlText).toContain("NOT (");
      expect(sqlText).toContain("AND");
    });
  });

  describe("AND with filter operators", () => {
    it("should AND-combine clauses containing filter operators", () => {
      const results = resolve({
        AND: [
          { age: { gte: 18 } },
          { age: { lte: 65 } },
        ],
      });
      expect(results).toHaveLength(1);
      const s = results[0].sql;
      expect(s).toContain("`age` >=");
      expect(s).toContain("`age` <=");
      expect(s).toContain("AND");
      expect(results[0].values).toEqual([18, 65]);
    });
  });

  describe("startsWith/endsWith escape", () => {
    it("startsWith should escape % and _", () => {
      const result = resolveSingle({ name: { startsWith: "50%" } });
      expect(result.values).toContain("50\\%%");
    });

    it("endsWith should escape % and _", () => {
      const result = resolveSingle({ name: { endsWith: "user_1" } });
      expect(result.values).toContain("%user\\_1");
    });
  });

  describe("empty OR/AND arrays", () => {
    it("empty OR should produce no conditions", () => {
      const results = resolve({ OR: [] });
      expect(results).toHaveLength(0);
    });

    it("empty AND should produce no conditions", () => {
      const results = resolve({ AND: [] });
      expect(results).toHaveLength(0);
    });
  });

  describe("nested NOT with OR", () => {
    it("NOT: { OR: [...] } should negate the OR group", () => {
      const results = resolve({
        NOT: {
          OR: [
            { status: "banned" },
            { status: "deleted" },
          ],
        },
      });
      expect(results).toHaveLength(1);
      const s = results[0].sql;
      expect(s).toContain("NOT (");
      expect(s).toContain("OR");
    });
  });

  describe("undefined where", () => {
    it("should return empty array for undefined", () => {
      const results = resolveWhereClause<User>(undefined, { wrapColumn: wrap });
      expect(results).toEqual([]);
    });
  });

  describe("empty array where", () => {
    it("should return empty array for empty array", () => {
      const results = resolve([]);
      expect(results).toEqual([]);
    });
  });

  describe("dialectExpression integration", () => {
    function resolveWithDialect(
      where: WhereClause<User>,
      dialect: "mysql" | "postgres" | "sqlite",
    ) {
      const results = resolveWhereClause<User>(where, {
        wrapColumn: wrap,
        dialect,
        dialectExpression: createDialectExpression(dialect),
      });
      expect(results.length).toBeGreaterThan(0);
      return results[0];
    }

    it("ilike uses ILIKE on postgres", () => {
      const result = resolveWithDialect({ name: { ilike: "%alice%" } }, "postgres");
      expect(result.sql).toContain("ILIKE");
      expect(result.values).toContain("%alice%");
    });

    it("ilike translates to LIKE on mysql", () => {
      const result = resolveWithDialect({ name: { ilike: "%alice%" } }, "mysql");
      expect(result.sql).toContain("LIKE");
      expect(result.sql).not.toContain("ILIKE");
      expect(result.values).toContain("%alice%");
    });

    it("ilike translates to LIKE on sqlite", () => {
      const result = resolveWithDialect({ name: { ilike: "%alice%" } }, "sqlite");
      expect(result.sql).toContain("LIKE");
      expect(result.sql).not.toContain("ILIKE");
      expect(result.values).toContain("%alice%");
    });

    it("search uses MATCH AGAINST on mysql", () => {
      const result = resolveWithDialect({ name: { search: "hello" } }, "mysql");
      expect(result.sql).toContain("MATCH");
      expect(result.sql).toContain("AGAINST");
    });

    it("search uses tsvector on postgres", () => {
      const result = resolveWithDialect({ name: { search: "hello" } }, "postgres");
      expect(result.sql).toContain("to_tsvector");
      expect(result.sql).toContain("plainto_tsquery");
    });
  });
});

// ── undefined operands, IN elements and combinator branches ─────────────

describe("WhereResolver: undefined values", () => {
  const u = undefined as any;

  function captureError(fn: () => unknown): any {
    try {
      fn();
    } catch (err) {
      return err;
    }
    throw new Error("expected the call to throw");
  }

  describe("operator operands", () => {
    it.each([
      "eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "like", "notLike",
      "ilike", "between", "isNull", "not", "contains", "startsWith", "endsWith",
      "search",
    ])("%s: undefined throws InvalidQueryError naming the field and operator", (op) => {
      const err = captureError(() => resolve({ name: { [op]: u } } as any));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain(`Operator "${op}" on "name" received undefined.`);
    });

    it("names the where key, not the wrapped column", () => {
      const err = captureError(() =>
        resolveWhereClause<User>({ age: { gt: u } }, {
          wrapColumn: wrap,
          qualified: true,
          tableName: "users",
        }),
      );
      expect(err.message).toContain('"age"');
      expect(err.message).not.toContain("`users`");
    });

    it("isNull: undefined no longer resolves to IS NOT NULL", () => {
      expect(() => resolve({ bio: { isNull: u } })).toThrow(InvalidQueryError);
      expect(resolveSingle({ bio: { isNull: false } }).sql).toContain("IS NOT NULL");
    });

    it("an undefined operand inside not: { ... } throws", () => {
      expect(() => resolve({ age: { not: { gt: u } } })).toThrow(
        'Operator "gt" on "age" received undefined.',
      );
    });

    it("null operands keep their meaning", () => {
      expect(resolveSingle({ bio: { eq: null } }).sql).toContain("`bio` IS NULL");
      expect(resolveSingle({ bio: { ne: null } }).sql).toContain("`bio` IS NOT NULL");
      expect(resolveSingle({ bio: { not: null } }).sql).toContain("`bio` IS NOT NULL");
    });
  });

  describe("IN lists and between bounds", () => {
    it.each([
      ["in operator", { age: { in: [1, u] } }, "in", 1],
      ["notIn operator", { age: { notIn: [u] } }, "notIn", 0],
      ["top-level array", { age: [1, 2, u] }, "IN", 2],
    ])("%s with an undefined element throws", (_label, where, op, index) => {
      const err = captureError(() => resolve(where as any));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain(
        `The ${op} list for "age" contains undefined at index ${index}.`,
      );
    });

    it("null elements in an IN list are still bound", () => {
      const result = resolveSingle({ bio: { in: ["a", null] } as any });
      expect(result.values).toEqual(["a", null]);
    });

    it.each([
      [[1, u], "max is undefined"],
      [[u, 5], "min is undefined"],
      [[1], "max is undefined"],
      [null, "received null"],
    ])("between %p throws (%s)", (bounds, detail) => {
      const err = captureError(() => resolve({ age: { between: bounds } } as any));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain(detail);
    });
  });

  describe("combinator branches", () => {
    it("array form: an element that resolves to nothing throws", () => {
      const err = captureError(() => resolve([{ name: u }, { id: 2 }]));
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err.message).toContain("OR branch [0]");
    });

    it("OR: an empty or all-undefined branch throws", () => {
      expect(() => resolve({ OR: [{ id: 1 }, {}] })).toThrow("OR branch OR[1]");
      expect(() => resolve({ OR: [{ name: u }] })).toThrow("OR branch OR[0]");
    });

    it("AND: an empty branch is skipped", () => {
      const results = resolve({ AND: [{}, { id: 2 }, { name: u }] });
      expect(results).toHaveLength(1);
      expect(results[0].sql).toContain("`id` =");
      expect(results[0].values).toEqual([2]);
    });

    it("OR / AND / NOT set to undefined are absent keys", () => {
      expect(resolve({ OR: u, AND: u, NOT: u })).toEqual([]);
      const results = resolve({ OR: u, status: "active" });
      expect(results).toHaveLength(1);
      expect(results[0].values).toEqual(["active"]);
    });

    it("{ OR: [] } and { AND: [] } still resolve to nothing", () => {
      expect(resolve({ OR: [] })).toEqual([]);
      expect(resolve({ AND: [] })).toEqual([]);
    });
  });
});

describe("findVacuousWhere", () => {
  const u = undefined as any;

  it.each([
    [{ id: u }, ["id"]],
    [{ id: u, name: u }, ["id", "name"]],
    [{ NOT: { id: u } }, ["NOT.id"]],
    [{ title: u, OR: [{ status: u }], NOT: { score: u } }, ["title", "OR[0].status", "NOT.score"]],
    [[{ id: u }, { name: u }], ["[0].id", "[1].name"]],
    [{ id: u, OR: [] }, ["id"]],
    [{ AND: [{ id: u }, {}] }, ["AND[0].id"]],
  ])("%p is vacuous", (where, paths) => {
    expect(findVacuousWhere(where)).toEqual(paths);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty object", {}],
    ["empty array", []],
    ["empty OR", { OR: [] }],
    ["combinator set to undefined", { OR: undefined }],
    ["one defined field", { id: 1 }],
    ["partial undefined", { id: u, status: "open" }],
    ["null value", { id: null }],
    ["defined NOT leaf", { id: u, NOT: { title: "a" } }],
    ["defined leaf in a later OR branch", { OR: [{ id: u }, { id: 2 }] }],
    ["operator object", { id: { eq: u } }],
    ["function value only", { hook: () => 1 }],
  ])("%s is not vacuous", (_label, where) => {
    expect(findVacuousWhere(where)).toBeNull();
  });

  it("skips function values when the rest is undefined", () => {
    expect(findVacuousWhere({ id: u, hook: () => 1 })).toEqual(["id"]);
  });

  it("ignores inherited enumerable properties", () => {
    const where = Object.create({ inherited: 1 });
    where.id = u;
    expect(findVacuousWhere(where)).toEqual(["id"]);
  });

  it("assertWhereNotVacuous names the method, entity and paths", () => {
    let err: any;
    try {
      assertWhereNotVacuous({ id: u }, "exists", "Post");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidQueryError);
    expect(err.message).toContain(
      'Every value in the "where" passed to exists() for entity "Post" is undefined (id) — the check would match any row.',
    );
    expect(err.suggestion).toContain("Pass null to match IS NULL");
    expect(() => assertWhereNotVacuous({ id: 1 }, "findOne", "Post")).not.toThrow();
  });
});
