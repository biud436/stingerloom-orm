import "reflect-metadata";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import {
  rowNumber,
  rank,
  denseRank,
  ntile,
  percentRank,
  cumeDist,
  lag,
  lead,
  firstValue,
  lastValue,
  nthValue,
} from "../../src/core/expressions/WindowFunctions";
import { WindowBuilder } from "../../src/core/expressions/WindowExpression";
import { ColumnExpression } from "../../src/core/SelectQueryBuilder";
import { createDialectExpression } from "../../src/dialects/DialectExpression";

const resolvePg = (ref: string): string => {
  if (ref === "*") return "*";
  if (!ref.includes(".")) return `"${ref}"`;
  const [alias, col] = ref.split(".");
  return `"${alias}"."${col}"`;
};

const pg = createDialectExpression("postgres");

describe("Window function factories", () => {
  describe("ranking heads (no arguments)", () => {
    it.each([
      ["rowNumber", rowNumber, "ROW_NUMBER"],
      ["rank", rank, "RANK"],
      ["denseRank", denseRank, "DENSE_RANK"],
      ["percentRank", percentRank, "PERCENT_RANK"],
      ["cumeDist", cumeDist, "CUME_DIST"],
    ] as const)("%s renders as %s()", (_label, factory, expected) => {
      const built = factory().as("col");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain(`${expected}() OVER ()`);
    });

    it("renders with PARTITION BY and ORDER BY", () => {
      const i = new ColumnExpression("i.teamId");
      const o = new ColumnExpression("i.score");
      const built = rowNumber().partitionBy(i).orderBy(o.desc()).as("rn");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain(
        `ROW_NUMBER() OVER (PARTITION BY "i"."teamId" ORDER BY "i"."score" DESC)`,
      );
    });
  });

  describe("NTILE", () => {
    it("renders with the n argument as a bound parameter", () => {
      const built = ntile(4).orderBy(new ColumnExpression("i.score").desc()).as("quartile");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain("NTILE(?)");
      expect(r.values).toEqual([4]);
    });

    it("rejects non-positive n", () => {
      expect(() => ntile(0)).toThrow(/positive integer/);
      expect(() => ntile(-1)).toThrow();
      expect(() => ntile(1.5)).toThrow();
    });
  });

  describe("LAG / LEAD", () => {
    it("default offset of 1 renders as FUNC(arg)", () => {
      const built = lag(new ColumnExpression("a.createdAt"))
        .partitionBy(new ColumnExpression("a.issueId"))
        .orderBy(new ColumnExpression("a.createdAt").asc())
        .as("prev");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain(`LAG("a"."createdAt") OVER`);
    });

    it("custom offset renders as FUNC(arg, offset)", () => {
      const built = lead(new ColumnExpression("a.value"), 3).as("future");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain("LEAD(");
      expect(r.values).toContain(3);
    });

    it("with default value renders 3-arg form", () => {
      const built = lag(new ColumnExpression("a.value"), 1, 0).as("prev");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain("LAG(");
      expect(r.values).toEqual(expect.arrayContaining([1, 0]));
    });
  });

  describe("FIRST_VALUE / LAST_VALUE / NTH_VALUE", () => {
    it("FIRST_VALUE renders with expr argument", () => {
      const built = firstValue(new ColumnExpression("i.amount"))
        .partitionBy(new ColumnExpression("i.userId"))
        .as("first_amount");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain(`FIRST_VALUE("i"."amount") OVER`);
    });

    it("LAST_VALUE renders with expr argument", () => {
      const built = lastValue(new ColumnExpression("i.amount")).as("last_amount");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain(`LAST_VALUE("i"."amount")`);
    });

    it("NTH_VALUE renders with expr and bound n", () => {
      const built = nthValue(new ColumnExpression("i.amount"), 3).as("third");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain("NTH_VALUE");
      expect(r.values).toContain(3);
    });

    it("NTH_VALUE rejects non-positive n", () => {
      expect(() => nthValue("col", 0)).toThrow();
      expect(() => nthValue("col", -1)).toThrow();
    });
  });

  describe("frame clauses", () => {
    it("ROWS BETWEEN frame composes into OVER", () => {
      const built = firstValue(new ColumnExpression("i.amount"))
        .orderBy(new ColumnExpression("i.createdAt").asc())
        .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
        .as("running_first");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW");
    });

    it("RANGE BETWEEN frame composes into OVER", () => {
      const built = firstValue(new ColumnExpression("i.amount"))
        .orderBy(new ColumnExpression("i.createdAt").asc())
        .rangeBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
        .as("x");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain("RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW");
    });
  });

  describe("Expressions namespace exposure", () => {
    it("Expressions.rowNumber returns a WindowBuilder", () => {
      expect(Expressions.rowNumber()).toBeInstanceOf(WindowBuilder);
    });
    it("Expressions.lag / lead are exposed", () => {
      expect(Expressions.lag("col")).toBeInstanceOf(WindowBuilder);
      expect(Expressions.lead("col")).toBeInstanceOf(WindowBuilder);
    });
    it("Expressions.firstValue / lastValue / nthValue are exposed", () => {
      expect(Expressions.firstValue("col")).toBeInstanceOf(WindowBuilder);
      expect(Expressions.lastValue("col")).toBeInstanceOf(WindowBuilder);
      expect(Expressions.nthValue("col", 1)).toBeInstanceOf(WindowBuilder);
    });
  });

  describe("AggregateExpression.over() preserves the aggregate-window path", () => {
    it("legacy SUM(x) OVER (PARTITION BY ...) still renders", () => {
      const u = new ColumnExpression("u.score");
      const built = u.sum().over().partitionBy(new ColumnExpression("u.teamId")).as("running_total");
      const r = built.renderer(resolvePg, pg);
      expect(r.sql).toContain(`SUM("u"."score") OVER (PARTITION BY "u"."teamId")`);
    });
  });
});
