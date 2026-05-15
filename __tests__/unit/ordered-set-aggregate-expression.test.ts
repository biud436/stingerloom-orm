import "reflect-metadata";
import sql from "sql-template-tag";
import {
  OrderedSetAggregateExpression,
  percentileCont,
  percentileDisc,
  mode,
  isOrderedSetAggregateExpression,
} from "../../src/core/expressions/OrderedSetAggregateExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import { ColumnExpression } from "../../src/core/SelectQueryBuilder";
import { ScalarExpression } from "../../src/core/expressions/ScalarExpression";
import { AliasedExpression, isAliasedExpression } from "../../src/core/expressions/AliasedExpression";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

const resolvePg = (ref: string): string => {
  if (ref === "*") return "*";
  if (!ref.includes(".")) return `"${ref}"`;
  const [alias, col] = ref.split(".");
  return `"${alias}"."${col}"`;
};

const pg = createDialectExpression("postgres");
const mysql = createDialectExpression("mysql");
const sqlite = createDialectExpression("sqlite");

describe("OrderedSetAggregateExpression", () => {
  describe("constructor validation", () => {
    it("rejects percentile_cont without a fraction", () => {
      expect(
        () =>
          new OrderedSetAggregateExpression(
            "percentile_cont",
            undefined,
            "i.cycle",
            "ASC",
            undefined,
          ),
      ).toThrow(/fraction/);
    });

    it("rejects out-of-range fraction", () => {
      expect(() => percentileCont(1.5, "i.cycle")).toThrow(/\[0, 1\]/);
      expect(() => percentileCont(-0.1, "i.cycle")).toThrow(/\[0, 1\]/);
      expect(() => percentileCont(Number.NaN, "i.cycle")).toThrow(/\[0, 1\]/);
    });

    it("accepts boundary values 0 and 1", () => {
      expect(() => percentileCont(0, "i.cycle")).not.toThrow();
      expect(() => percentileCont(1, "i.cycle")).not.toThrow();
    });

    it("rejects a fraction on mode()", () => {
      expect(
        () =>
          new OrderedSetAggregateExpression(
            "mode",
            0.5,
            "i.cycle",
            "ASC",
            undefined,
          ),
      ).toThrow(/no fraction/);
    });
  });

  describe("PostgreSQL rendering", () => {
    it("renders percentile_cont with a column reference and bound fraction", () => {
      const expr = percentileCont(0.5, "i.cycle");
      const rendered = expr.render(resolvePg, pg);
      expect(rendered.sql).toBe(
        `percentile_cont(?) WITHIN GROUP (ORDER BY "i"."cycle")`,
      );
      expect(rendered.values).toEqual([0.5]);
    });

    it("renders percentile_disc with bound fraction", () => {
      const expr = percentileDisc(0.95, "i.cycle");
      const rendered = expr.render(resolvePg, pg);
      expect(rendered.sql).toBe(
        `percentile_disc(?) WITHIN GROUP (ORDER BY "i"."cycle")`,
      );
      expect(rendered.values).toEqual([0.95]);
    });

    it("renders mode() with no fraction", () => {
      const expr = mode("i.status");
      const rendered = expr.render(resolvePg, pg);
      expect(rendered.sql).toBe(
        `mode() WITHIN GROUP (ORDER BY "i"."status")`,
      );
      expect(rendered.values).toEqual([]);
    });

    it("emits DESC sort when .desc() is chained", () => {
      const expr = percentileCont(0.5, "i.cycle").desc();
      const rendered = expr.render(resolvePg, pg);
      expect(rendered.sql).toContain(`ORDER BY "i"."cycle" DESC`);
    });

    it("unwraps a ColumnExpression order target", () => {
      const col = new ColumnExpression("i.cycle");
      const expr = percentileCont(0.5, col);
      const rendered = expr.render(resolvePg, pg);
      expect(rendered.sql).toBe(
        `percentile_cont(?) WITHIN GROUP (ORDER BY "i"."cycle")`,
      );
      expect(rendered.values).toEqual([0.5]);
    });

    it("unwraps a ScalarExpression order target and preserves its bindings", () => {
      const scalar = new ScalarExpression(() => sql`(${42} + 1)`);
      const expr = percentileCont(0.5, scalar);
      const rendered = expr.render(resolvePg, pg);
      expect(rendered.sql).toBe(
        `percentile_cont(?) WITHIN GROUP (ORDER BY (? + 1))`,
      );
      expect(rendered.values).toEqual([0.5, 42]);
    });
  });

  describe("dialect support gates", () => {
    it("throws UNSUPPORTED_OPERATION on MySQL with a CTE/ROW_NUMBER emulation hint", () => {
      const expr = percentileCont(0.5, "i.cycle");
      try {
        expr.render(resolvePg, mysql);
        fail("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(OrmError);
        expect((e as OrmError).code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
        const msg = (e as OrmError).message;
        // Helper-built shape: names the feature, the failing dialect, why,
        // a concrete alternative (CTE + ROW_NUMBER emulation), and a docs
        // pointer. Pinning these substrings keeps the error contract
        // testable without depending on exact wording.
        expect(msg).toMatch(/percentile_cont/);
        expect(msg).toMatch(/mysql/);
        expect(msg).toMatch(/PostgreSQL/);
        expect(msg).toMatch(/CTE/);
        expect(msg).toMatch(/ROW_NUMBER/);
        expect(msg).toMatch(/Alternative:/);
        expect(msg).toMatch(/See: docs\//);
        // The `suggestion` field carries the alternative as a single-line
        // hint suitable for direct surfacing in error UIs.
        expect((e as OrmError).suggestion).toMatch(/CTE/);
      }
    });

    it("throws UNSUPPORTED_OPERATION on SQLite", () => {
      const expr = percentileCont(0.5, "i.cycle");
      try {
        expr.render(resolvePg, sqlite);
        fail("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(OrmError);
        expect((e as OrmError).code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
        // SQLite has no emulation path; the message should still point at
        // PostgreSQL and the docs.
        expect((e as OrmError).message).toMatch(/PostgreSQL/);
        expect((e as OrmError).message).toMatch(/sqlite/);
      }
    });

    it("throws when no dialect is provided", () => {
      const expr = percentileCont(0.5, "i.cycle");
      expect(() => expr.render(resolvePg)).toThrow(/DialectExpression/);
    });
  });

  describe("alias handling", () => {
    it(".as() returns an AliasedExpression with the chosen alias", () => {
      const a = percentileCont(0.5, "i.cycle").as("p50");
      expect(isAliasedExpression(a)).toBe(true);
      expect(a).toBeInstanceOf(AliasedExpression);
      expect(a.alias).toBe("p50");
    });

    it("AliasedExpression renderer reproduces the underlying SQL", () => {
      const a = percentileCont(0.5, "i.cycle").as("p50");
      const rendered = a.renderer(resolvePg, pg);
      expect(rendered.sql).toBe(
        `percentile_cont(?) WITHIN GROUP (ORDER BY "i"."cycle")`,
      );
      expect(rendered.values).toEqual([0.5]);
    });

    it("getAlias() generates a deterministic default", () => {
      expect(percentileCont(0.5, "i.cycle").getAlias()).toBe(
        "agg_percentile_cont_50",
      );
      expect(percentileDisc(0.95, "i.cycle").getAlias()).toBe(
        "agg_percentile_disc_95",
      );
      expect(mode("i.cycle").getAlias()).toBe("agg_mode");
    });

    it("explicit alias overrides the default", () => {
      const a = percentileCont(0.5, "i.cycle").as("median");
      expect(a.alias).toBe("median");
    });
  });

  describe("immutability", () => {
    it(".asc() / .desc() return a new instance without mutating the source", () => {
      const a = percentileCont(0.5, "i.cycle");
      const b = a.desc();
      expect(a.orderDirection).toBe("ASC");
      expect(b.orderDirection).toBe("DESC");
      expect(a).not.toBe(b);
    });
  });

  describe("type guard / Expressions namespace", () => {
    it("isOrderedSetAggregateExpression recognizes instances", () => {
      expect(isOrderedSetAggregateExpression(percentileCont(0.5, "i.x"))).toBe(
        true,
      );
      expect(isOrderedSetAggregateExpression({})).toBe(false);
      expect(isOrderedSetAggregateExpression(null)).toBe(false);
    });

    it("Expressions.percentileCont/Disc/mode are exposed on the namespace", () => {
      expect(Expressions.percentileCont(0.5, "i.cycle")).toBeInstanceOf(
        OrderedSetAggregateExpression,
      );
      expect(Expressions.percentileDisc(0.5, "i.cycle")).toBeInstanceOf(
        OrderedSetAggregateExpression,
      );
      expect(Expressions.mode("i.cycle")).toBeInstanceOf(
        OrderedSetAggregateExpression,
      );
    });
  });
});
