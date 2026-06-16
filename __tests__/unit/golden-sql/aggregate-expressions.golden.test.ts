import "reflect-metadata";
import { Expressions } from "../../../src/core/expressions/LogicalCondition";
import { ColumnExpression } from "../../../src/core/SelectQueryBuilder";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { runGoldenMatrix, type GoldenCase } from "./harness";

/**
 * Golden SQL — aggregate + ordered-set aggregate expressions.
 *
 * Ordered-set aggregates (`percentile_cont` / `percentile_disc` / `mode`)
 * are PostgreSQL-only; the MySQL and SQLite renderers must reject them with
 * `OrmErrorCode.UNSUPPORTED_OPERATION` rather than emit invalid SQL.
 */

const aggregateCases: GoldenCase[] = [
  {
    name: "COUNT(*) — wildcard argument is emitted verbatim",
    build: () => Expressions.count("*"),
    postgres: { text: "COUNT(*)", values: [] },
    mysql: { text: "COUNT(*)", values: [] },
    sqlite: { text: "COUNT(*)", values: [] },
  },
  {
    name: "SUM(column) — single column reference",
    build: () => new ColumnExpression("u.amount").sum(),
    postgres: { text: 'SUM("u"."amount")', values: [] },
    mysql: { text: "SUM(`u`.`amount`)", values: [] },
    sqlite: { text: 'SUM("u"."amount")', values: [] },
  },
  {
    name: "COUNT(column) — single column reference",
    build: () => new ColumnExpression("u.id").count(),
    postgres: { text: 'COUNT("u"."id")', values: [] },
    mysql: { text: "COUNT(`u`.`id`)", values: [] },
    sqlite: { text: 'COUNT("u"."id")', values: [] },
  },
  {
    name: "COUNT(DISTINCT column)",
    build: () =>
      Expressions.aggregate("COUNT", new ColumnExpression("u.email"), {
        distinct: true,
      }),
    postgres: { text: 'COUNT(DISTINCT "u"."email")', values: [] },
    mysql: { text: "COUNT(DISTINCT `u`.`email`)", values: [] },
    sqlite: { text: 'COUNT(DISTINCT "u"."email")', values: [] },
  },
  {
    name: "AVG over a derived dateDiff scalar (per-dialect inner SQL)",
    build: () =>
      Expressions.avg(
        Expressions.dateDiff(
          new ColumnExpression("i.completedAt"),
          new ColumnExpression("i.createdAt"),
          "hour",
        ),
      ),
    postgres: {
      text:
        'AVG(CAST(EXTRACT(EPOCH FROM ("i"."completedAt" - "i"."createdAt")) ' +
        "/ ? AS INTEGER))",
      values: [3600],
    },
    mysql: {
      text: "AVG(TIMESTAMPDIFF(HOUR, `i`.`createdAt`, `i`.`completedAt`))",
      values: [],
    },
    sqlite: {
      text:
        'AVG(CAST((julianday("i"."completedAt") - julianday("i"."createdAt")) ' +
        "* ? AS INTEGER))",
      values: [24],
    },
  },
];

const orderedSetCases: GoldenCase[] = [
  {
    name: "percentile_cont(0.5) WITHIN GROUP — PostgreSQL only",
    build: () => Expressions.percentileCont(0.5, new ColumnExpression("i.cycle")),
    postgres: {
      text: 'percentile_cont(?) WITHIN GROUP (ORDER BY "i"."cycle")',
      values: [0.5],
    },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
  },
  {
    name: "percentile_disc(0.95) WITHIN GROUP ... DESC",
    build: () => Expressions.percentileDisc(0.95, "i.cycle").desc(),
    postgres: {
      text: 'percentile_disc(?) WITHIN GROUP (ORDER BY "i"."cycle" DESC)',
      values: [0.95],
    },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
  },
  {
    name: "mode() WITHIN GROUP — no fraction argument",
    build: () => Expressions.mode("i.status"),
    postgres: {
      text: 'mode() WITHIN GROUP (ORDER BY "i"."status")',
      values: [],
    },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
  },
  {
    name: "percentile_cont(0.9).as('p90') — alias renderer keeps dialect gate",
    build: () =>
      Expressions.percentileCont(0.9, new ColumnExpression("i.cycle")).as("p90"),
    postgres: {
      text: 'percentile_cont(?) WITHIN GROUP (ORDER BY "i"."cycle")',
      values: [0.9],
    },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
  },
];

/**
 * Aggregate `FILTER (WHERE …)` — native on PostgreSQL/SQLite, rewritten to
 * `FUNC(CASE WHEN … THEN … END)` on MySQL. `COUNT(*)` substitutes a literal
 * `1` inside the MySQL CASE because `*` is not a valid CASE result.
 */
const filterCases: GoldenCase[] = [
  {
    name: "COUNT(*) FILTER (WHERE …) — wildcard becomes 1 on MySQL",
    build: () =>
      Expressions.count("*").filter(
        new ColumnExpression("u.status").eq("active"),
      ),
    postgres: {
      text: 'COUNT(*) FILTER (WHERE "u"."status" = ?)',
      values: ["active"],
    },
    mysql: {
      text: "COUNT(CASE WHEN `u`.`status` = ? THEN 1 END)",
      values: ["active"],
    },
    sqlite: {
      text: 'COUNT(*) FILTER (WHERE "u"."status" = ?)',
      values: ["active"],
    },
  },
  {
    name: "SUM(column) FILTER (WHERE …)",
    build: () =>
      new ColumnExpression("o.amount")
        .sum()
        .filter(new ColumnExpression("o.type").eq("refund")),
    postgres: {
      text: 'SUM("o"."amount") FILTER (WHERE "o"."type" = ?)',
      values: ["refund"],
    },
    mysql: {
      text: "SUM(CASE WHEN `o`.`type` = ? THEN `o`.`amount` END)",
      values: ["refund"],
    },
    sqlite: {
      text: 'SUM("o"."amount") FILTER (WHERE "o"."type" = ?)',
      values: ["refund"],
    },
  },
  {
    name: "countIf(condition) shorthand — COUNT(column) FILTER",
    build: () =>
      new ColumnExpression("u.id").countIf(
        new ColumnExpression("u.verified").eq(true),
      ),
    postgres: {
      text: 'COUNT("u"."id") FILTER (WHERE "u"."verified" = ?)',
      values: [true],
    },
    mysql: {
      text: "COUNT(CASE WHEN `u`.`verified` = ? THEN `u`.`id` END)",
      values: [true],
    },
    sqlite: {
      text: 'COUNT("u"."id") FILTER (WHERE "u"."verified" = ?)',
      values: [true],
    },
  },
  {
    name: "sumIf(condition) shorthand — SUM(column) FILTER",
    build: () =>
      new ColumnExpression("o.amount").sumIf(
        new ColumnExpression("o.status").eq("paid"),
      ),
    postgres: {
      text: 'SUM("o"."amount") FILTER (WHERE "o"."status" = ?)',
      values: ["paid"],
    },
    mysql: {
      text: "SUM(CASE WHEN `o`.`status` = ? THEN `o`.`amount` END)",
      values: ["paid"],
    },
    sqlite: {
      text: 'SUM("o"."amount") FILTER (WHERE "o"."status" = ?)',
      values: ["paid"],
    },
  },
  {
    name: "COUNT(DISTINCT column) FILTER — DISTINCT inside the CASE on MySQL",
    build: () =>
      new ColumnExpression("u.email")
        .countDistinct()
        .filter(new ColumnExpression("u.status").eq("active")),
    postgres: {
      text: 'COUNT(DISTINCT "u"."email") FILTER (WHERE "u"."status" = ?)',
      values: ["active"],
    },
    mysql: {
      text: "COUNT(DISTINCT CASE WHEN `u`.`status` = ? THEN `u`.`email` END)",
      values: ["active"],
    },
    sqlite: {
      text: 'COUNT(DISTINCT "u"."email") FILTER (WHERE "u"."status" = ?)',
      values: ["active"],
    },
  },
  {
    name: "FILTER with a composed AND predicate",
    build: () =>
      new ColumnExpression("u.id")
        .count()
        .filter(
          new ColumnExpression("u.status")
            .eq("active")
            .and(new ColumnExpression("u.age").gte(18)),
        ),
    postgres: {
      text:
        'COUNT("u"."id") FILTER (WHERE ("u"."status" = ? AND "u"."age" >= ?))',
      values: ["active", 18],
    },
    mysql: {
      text:
        "COUNT(CASE WHEN (`u`.`status` = ? AND `u`.`age` >= ?) THEN `u`.`id` END)",
      values: ["active", 18],
    },
    sqlite: {
      text:
        'COUNT("u"."id") FILTER (WHERE ("u"."status" = ? AND "u"."age" >= ?))',
      values: ["active", 18],
    },
  },
];

runGoldenMatrix("golden-sql / aggregate expressions", aggregateCases);
runGoldenMatrix("golden-sql / ordered-set aggregate expressions", orderedSetCases);
runGoldenMatrix("golden-sql / aggregate FILTER (WHERE …)", filterCases);
