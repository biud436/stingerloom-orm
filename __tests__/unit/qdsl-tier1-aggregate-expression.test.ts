import {
  AggregateExpression,
  AggregateCondition,
  isAggregateExpression,
  isAggregateCondition,
} from "../../src/core/expressions/AggregateExpression";
import { LogicalCondition } from "../../src/core/expressions/LogicalCondition";

// A minimal column resolver that quotes identifiers like the Postgres driver
// would, so assertions can check realistic output without bootstrapping
// EntityManager.
const resolvePg = (ref: string): string => {
  if (ref === "*") return "*";
  if (!ref.includes(".")) return `"${ref}"`;
  const [alias, col] = ref.split(".");
  return `"${alias}"."${col}"`;
};

describe("AggregateExpression (QueryDSL Tier 1)", () => {
  describe("renderFunction()", () => {
    it("renders COUNT with the qualified column", () => {
      const agg = new AggregateExpression("u.id", "COUNT", false, undefined);
      const sql = agg.renderFunction(resolvePg);
      expect(sql.sql).toBe(`COUNT("u"."id")`);
      expect(sql.values).toEqual([]);
    });

    it("renders SUM", () => {
      const agg = new AggregateExpression("u.amount", "SUM", false, undefined);
      expect(agg.renderFunction(resolvePg).sql).toBe(`SUM("u"."amount")`);
    });

    it("renders AVG / MIN / MAX", () => {
      expect(
        new AggregateExpression("u.score", "AVG", false, undefined).renderFunction(resolvePg).sql,
      ).toBe(`AVG("u"."score")`);
      expect(
        new AggregateExpression("u.score", "MIN", false, undefined).renderFunction(resolvePg).sql,
      ).toBe(`MIN("u"."score")`);
      expect(
        new AggregateExpression("u.score", "MAX", false, undefined).renderFunction(resolvePg).sql,
      ).toBe(`MAX("u"."score")`);
    });

    it("renders COUNT(DISTINCT ...)", () => {
      const agg = new AggregateExpression("u.email", "COUNT", true, undefined);
      expect(agg.renderFunction(resolvePg).sql).toBe(`COUNT(DISTINCT "u"."email")`);
    });

    it("renders COUNT(*) when ref is *", () => {
      const agg = new AggregateExpression("*", "COUNT", false, undefined);
      expect(agg.renderFunction(resolvePg).sql).toBe(`COUNT(*)`);
    });
  });

  describe("as() / getAlias()", () => {
    it("returns explicit alias when set", () => {
      const agg = new AggregateExpression("u.id", "COUNT", false, undefined).as("total");
      expect(agg.getAlias()).toBe("total");
      expect(agg.alias).toBe("total");
    });

    it("generates deterministic default alias without as()", () => {
      const agg = new AggregateExpression("u.id", "COUNT", false, undefined);
      expect(agg.getAlias()).toBe("agg_count_id");
    });

    it("default alias distinguishes DISTINCT variant", () => {
      const agg = new AggregateExpression("u.id", "COUNT", true, undefined);
      expect(agg.getAlias()).toBe("agg_count_distinct_id");
    });

    it("default alias strips alias prefix from ref", () => {
      const agg = new AggregateExpression("users.amount", "SUM", false, undefined);
      expect(agg.getAlias()).toBe("agg_sum_amount");
    });

    it("as() returns a new AggregateExpression without mutating the original", () => {
      const a = new AggregateExpression("u.id", "COUNT", false, undefined);
      const b = a.as("total");
      expect(a.alias).toBeUndefined();
      expect(b.alias).toBe("total");
      expect(b).not.toBe(a);
    });
  });

  describe("comparison methods produce AggregateCondition", () => {
    const agg = new AggregateExpression("u.id", "COUNT", false, undefined);

    it("eq/neq/gt/gte/lt/lte", () => {
      expect(agg.eq(1).resolve(resolvePg).sql).toBe(`COUNT("u"."id") = ?`);
      expect(agg.neq(1).resolve(resolvePg).sql).toBe(`COUNT("u"."id") != ?`);
      expect(agg.gt(1).resolve(resolvePg).sql).toBe(`COUNT("u"."id") > ?`);
      expect(agg.gte(1).resolve(resolvePg).sql).toBe(`COUNT("u"."id") >= ?`);
      expect(agg.lt(1).resolve(resolvePg).sql).toBe(`COUNT("u"."id") < ?`);
      expect(agg.lte(1).resolve(resolvePg).sql).toBe(`COUNT("u"."id") <= ?`);
    });

    it("between renders BETWEEN", () => {
      const cond = agg.between(5, 10);
      const sql = cond.resolve(resolvePg);
      expect(sql.sql).toBe(`COUNT("u"."id") BETWEEN ? AND ?`);
      expect(sql.values).toEqual([5, 10]);
    });

    it("gt parameterizes the value", () => {
      const cond = agg.gt(10);
      const sql = cond.resolve(resolvePg);
      expect(sql.values).toEqual([10]);
    });
  });

  describe("logical composition on AggregateCondition", () => {
    const agg = new AggregateExpression("u.id", "COUNT", false, undefined);

    it(".and() yields a LogicalCondition", () => {
      const c1 = agg.gt(10);
      const c2 = agg.lt(100);
      const combined = c1.and(c2);
      expect(combined).toBeInstanceOf(LogicalCondition);
      const sql = combined.resolve(resolvePg);
      expect(sql.sql).toBe(`(COUNT("u"."id") > ? AND COUNT("u"."id") < ?)`);
    });

    it(".or() yields a LogicalCondition", () => {
      const combined = agg.gt(100).or(agg.lt(5));
      const sql = combined.resolve(resolvePg);
      expect(sql.sql).toBe(`(COUNT("u"."id") > ? OR COUNT("u"."id") < ?)`);
    });

    it(".not() wraps in NOT", () => {
      const combined = agg.gt(10).not();
      const sql = combined.resolve(resolvePg);
      expect(sql.sql).toBe(`NOT (COUNT("u"."id") > ?)`);
    });
  });

  describe("asc()/desc()", () => {
    it("asc() returns OrderExpression with direction ASC", () => {
      const agg = new AggregateExpression("u.id", "COUNT", false, undefined);
      const o = agg.asc();
      expect(o.direction).toBe("ASC");
      expect(o.ref).toBe("u.id");
    });

    it("desc() returns OrderExpression with direction DESC", () => {
      const agg = new AggregateExpression("u.id", "COUNT", false, undefined);
      expect(agg.desc().direction).toBe("DESC");
    });
  });

  describe("type guards", () => {
    it("isAggregateExpression", () => {
      expect(isAggregateExpression(new AggregateExpression("u.id", "COUNT", false, undefined))).toBe(true);
      expect(isAggregateExpression({ func: "COUNT" })).toBe(false);
      expect(isAggregateExpression(null)).toBe(false);
    });

    it("isAggregateCondition", () => {
      const agg = new AggregateExpression("u.id", "COUNT", false, undefined);
      expect(isAggregateCondition(agg.gt(1))).toBe(true);
      expect(isAggregateCondition(agg)).toBe(false);
    });

    it("AggregateCondition implements ConditionLike marker", () => {
      const agg = new AggregateExpression("u.id", "COUNT", false, undefined);
      const cond = agg.gt(1);
      expect((cond as unknown as { __isCondition: unknown }).__isCondition).toBe(true);
    });
  });
});
