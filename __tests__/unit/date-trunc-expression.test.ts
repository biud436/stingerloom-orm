import "reflect-metadata";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import { ColumnExpression } from "../../src/core/SelectQueryBuilder";
import { createDialectExpression } from "../../src/dialects/DialectExpression";

const resolvePg = (ref: string): string => {
  if (ref === "*") return "*";
  if (!ref.includes(".")) return `"${ref}"`;
  const [alias, col] = ref.split(".");
  return `"${alias}"."${col}"`;
};

const resolveMy = (ref: string): string => {
  if (ref === "*") return "*";
  if (!ref.includes(".")) return `\`${ref}\``;
  const [alias, col] = ref.split(".");
  return `\`${alias}\`.\`${col}\``;
};

const pg = createDialectExpression("postgres");
const mysql = createDialectExpression("mysql");
const sqlite = createDialectExpression("sqlite");

describe("Expressions.dateTrunc", () => {
  describe("PostgreSQL — native date_trunc with bound unit", () => {
    it("renders day", () => {
      const r = Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "day").renderer(
        resolvePg,
        pg,
      );
      expect(r.sql).toBe(`date_trunc(?, "i"."completedAt")`);
      expect(r.values).toEqual(["day"]);
    });

    it("renders week (ISO-Monday)", () => {
      const r = Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "week").renderer(
        resolvePg,
        pg,
      );
      expect(r.values).toEqual(["week"]);
    });

    it.each(["year", "quarter", "month", "week", "day", "hour", "minute", "second"] as const)(
      "renders unit=%s",
      (unit) => {
        const r = Expressions.dateTrunc(
          new ColumnExpression("i.completedAt"),
          unit,
        ).renderer(resolvePg, pg);
        expect(r.values).toEqual([unit]);
      },
    );
  });

  describe("MySQL — per-unit explicit equivalents", () => {
    it("day uses DATE()", () => {
      const r = Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "day").renderer(
        resolveMy,
        mysql,
      );
      expect(r.sql).toBe("DATE(`i`.`completedAt`)");
    });

    it("week is ISO-Monday (DATE_SUB by WEEKDAY)", () => {
      const r = Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "week").renderer(
        resolveMy,
        mysql,
      );
      expect(r.sql).toContain("DATE_SUB");
      expect(r.sql).toContain("WEEKDAY(`i`.`completedAt`)");
    });

    it("month uses %Y-%m-01 format", () => {
      const r = Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "month").renderer(
        resolveMy,
        mysql,
      );
      expect(r.sql).toContain("'%Y-%m-01'");
    });

    it("quarter uses MAKEDATE + INTERVAL QUARTER", () => {
      const r = Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "quarter").renderer(
        resolveMy,
        mysql,
      );
      expect(r.sql).toContain("MAKEDATE");
      expect(r.sql).toContain("QUARTER");
    });
  });

  describe("SQLite — date() / strftime() emulation", () => {
    it("day uses 'start of day'", () => {
      const r = Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "day").renderer(
        resolveMy,
        sqlite,
      );
      expect(r.sql).toContain("'start of day'");
    });

    it("week uses %w-based ISO-Monday subtraction", () => {
      const r = Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "week").renderer(
        resolveMy,
        sqlite,
      );
      expect(r.sql).toContain("strftime('%w'");
    });

    it("month uses 'start of month'", () => {
      const r = Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "month").renderer(
        resolveMy,
        sqlite,
      );
      expect(r.sql).toContain("'start of month'");
    });
  });

  describe("composition", () => {
    it("can be chained into other expressions", () => {
      const week = Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "week");
      const aliased = week.as("weekStart");
      expect(aliased.alias).toBe("weekStart");
    });

    it("accepts string column references", () => {
      const r = Expressions.dateTrunc("i.completedAt", "day").renderer(resolvePg, pg);
      expect(r.sql).toBe(`date_trunc(?, "i"."completedAt")`);
    });

    it("throws when no dialect is provided", () => {
      const r = Expressions.dateTrunc("i.completedAt", "day");
      expect(() => r.renderer(resolvePg)).toThrow(/DialectExpression/);
    });
  });
});
