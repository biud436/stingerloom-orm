import {
  LogicalCondition,
  Expressions,
  isLogicalCondition,
} from "../../src/core/expressions/LogicalCondition";
import { ColumnCondition } from "../../src/core/SelectQueryBuilder";
import { AggregateExpression } from "../../src/core/expressions/AggregateExpression";

const resolve = (ref: string): string => {
  if (!ref.includes(".")) return `"${ref}"`;
  const [a, c] = ref.split(".");
  return `"${a}"."${c}"`;
};

const col = (ref: string, op: string, val: unknown) =>
  new ColumnCondition(ref, op, val);

describe("LogicalCondition (QueryDSL Tier 1)", () => {
  describe("construction", () => {
    it("AND with 2 children", () => {
      const lc = new LogicalCondition("AND", [
        col("u.age", ">=", 18),
        col("u.status", "=", "active"),
      ]);
      const sql = lc.resolve(resolve);
      expect(sql.sql).toBe(`("u"."age" >= ? AND "u"."status" = ?)`);
      expect(sql.values).toEqual([18, "active"]);
    });

    it("OR with 2 children", () => {
      const lc = new LogicalCondition("OR", [
        col("u.role", "=", "admin"),
        col("u.role", "=", "owner"),
      ]);
      expect(lc.resolve(resolve).sql).toBe(
        `("u"."role" = ? OR "u"."role" = ?)`,
      );
    });

    it("NOT wraps a single child", () => {
      const lc = new LogicalCondition("NOT", [col("u.active", "=", true)]);
      expect(lc.resolve(resolve).sql).toBe(`NOT ("u"."active" = ?)`);
    });

    it("single-child AND/OR collapses to just the child (no redundant parens)", () => {
      const lc = new LogicalCondition("AND", [col("u.age", ">=", 18)]);
      expect(lc.resolve(resolve).sql).toBe(`"u"."age" >= ?`);
    });

    it("throws on NOT with 0 or 2+ children", () => {
      expect(() => new LogicalCondition("NOT", [])).toThrow(/NOT.*1/);
      expect(
        () =>
          new LogicalCondition("NOT", [
            col("a", "=", 1),
            col("b", "=", 2),
          ]),
      ).toThrow(/NOT.*1/);
    });

    it("throws on AND/OR with 0 children", () => {
      expect(() => new LogicalCondition("AND", [])).toThrow(/AND.*at least 1/);
      expect(() => new LogicalCondition("OR", [])).toThrow(/OR.*at least 1/);
    });
  });

  describe("chained .and()/.or()/.not()", () => {
    it(".and() flattens contiguous ANDs", () => {
      const a = col("u.a", "=", 1);
      const b = col("u.b", "=", 2);
      const c = col("u.c", "=", 3);
      const combined = new LogicalCondition("AND", [a, b]).and(c);
      expect(combined.children.length).toBe(3);
      expect(combined.resolve(resolve).sql).toBe(
        `("u"."a" = ? AND "u"."b" = ? AND "u"."c" = ?)`,
      );
    });

    it(".or() flattens contiguous ORs", () => {
      const a = col("u.a", "=", 1);
      const b = col("u.b", "=", 2);
      const c = col("u.c", "=", 3);
      const combined = new LogicalCondition("OR", [a, b]).or(c);
      expect(combined.children.length).toBe(3);
    });

    it(".and() does not flatten into OR", () => {
      const or = new LogicalCondition("OR", [
        col("u.a", "=", 1),
        col("u.b", "=", 2),
      ]);
      const combined = or.and(col("u.c", "=", 3));
      expect(combined.op).toBe("AND");
      expect(combined.children.length).toBe(2);
      expect(combined.resolve(resolve).sql).toBe(
        `(("u"."a" = ? OR "u"."b" = ?) AND "u"."c" = ?)`,
      );
    });

    it(".not() wraps a LogicalCondition", () => {
      const or = new LogicalCondition("OR", [
        col("u.a", "=", 1),
        col("u.b", "=", 2),
      ]);
      const negated = or.not();
      expect(negated.op).toBe("NOT");
      expect(negated.resolve(resolve).sql).toBe(
        `NOT (("u"."a" = ? OR "u"."b" = ?))`,
      );
    });
  });

  describe("ColumnCondition composition", () => {
    it("ColumnCondition.and() returns a LogicalCondition", () => {
      const cond = col("u.age", ">=", 18).and(col("u.status", "=", "active"));
      expect(cond).toBeInstanceOf(LogicalCondition);
      expect(cond.resolve(resolve).sql).toBe(
        `("u"."age" >= ? AND "u"."status" = ?)`,
      );
    });

    it("associativity: a.and(b).or(c) === (a AND b) OR c", () => {
      const cond = col("u.a", "=", 1)
        .and(col("u.b", "=", 2))
        .or(col("u.c", "=", 3));
      expect(cond.resolve(resolve).sql).toBe(
        `(("u"."a" = ? AND "u"."b" = ?) OR "u"."c" = ?)`,
      );
    });

    it("ColumnCondition.not() wraps in NOT", () => {
      const cond = col("u.deleted_at", "IS NULL", undefined).not();
      expect(cond.resolve(resolve).sql).toBe(`NOT ("u"."deleted_at" IS NULL)`);
    });
  });

  describe("Expressions static helpers", () => {
    it("Expressions.and(a, b, c)", () => {
      const cond = Expressions.and(
        col("u.a", "=", 1),
        col("u.b", "=", 2),
        col("u.c", "=", 3),
      );
      expect(cond.op).toBe("AND");
      expect(cond.children.length).toBe(3);
    });

    it("Expressions.or(a, b)", () => {
      const cond = Expressions.or(col("u.a", "=", 1), col("u.b", "=", 2));
      expect(cond.op).toBe("OR");
    });

    it("Expressions.not(cond)", () => {
      const cond = Expressions.not(col("u.deleted_at", "IS NULL", undefined));
      expect(cond.op).toBe("NOT");
      expect(cond.children.length).toBe(1);
    });

    it("Expressions.or(and(a, b), c) groups correctly", () => {
      const cond = Expressions.or(
        Expressions.and(col("u.a", "=", 1), col("u.b", "=", 2)),
        col("u.c", "=", 3),
      );
      expect(cond.resolve(resolve).sql).toBe(
        `(("u"."a" = ? AND "u"."b" = ?) OR "u"."c" = ?)`,
      );
    });
  });

  describe("mixing condition types", () => {
    it("composes ColumnCondition with AggregateCondition", () => {
      const count = new AggregateExpression("u.id", "COUNT", false, undefined);
      const cond = Expressions.and(col("u.status", "=", "active"), count.gt(10));
      expect(cond.resolve(resolve).sql).toBe(
        `("u"."status" = ? AND COUNT("u"."id") > ?)`,
      );
    });
  });

  describe("isLogicalCondition type guard", () => {
    it("recognizes a LogicalCondition", () => {
      const lc = new LogicalCondition("AND", [col("a", "=", 1)]);
      expect(isLogicalCondition(lc)).toBe(true);
    });

    it("rejects ColumnCondition", () => {
      expect(isLogicalCondition(col("a", "=", 1))).toBe(false);
    });

    it("rejects null/undefined/primitives", () => {
      expect(isLogicalCondition(null)).toBe(false);
      expect(isLogicalCondition(undefined)).toBe(false);
      expect(isLogicalCondition("lc")).toBe(false);
    });
  });
});
