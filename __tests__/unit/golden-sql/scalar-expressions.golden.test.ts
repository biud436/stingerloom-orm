import "reflect-metadata";
import { Expressions } from "../../../src/core/expressions/LogicalCondition";
import { ColumnExpression } from "../../../src/core/SelectQueryBuilder";
import { runGoldenMatrix, type GoldenCase } from "./harness";

/**
 * Golden SQL — scalar expressions: CASE, date arithmetic, CAST, COALESCE/NULLIF.
 *
 * CASE / COALESCE / NULLIF render the same shape on every dialect (only
 * identifier quoting differs); date arithmetic and CAST type names are
 * where the dialect renderers diverge, so those carry the highest
 * regression risk.
 */

const caseCases: GoldenCase[] = [
  {
    name: "mapValues — simple CASE with object-literal branches",
    build: () =>
      Expressions.mapValues(
        new ColumnExpression("u.status"),
        { active: 1, pending: 0 },
        -1,
      ),
    postgres: {
      text: 'CASE "u"."status" WHEN ? THEN ? WHEN ? THEN ? ELSE ? END',
      values: ["active", 1, "pending", 0, -1],
    },
    mysql: {
      text: "CASE `u`.`status` WHEN ? THEN ? WHEN ? THEN ? ELSE ? END",
      values: ["active", 1, "pending", 0, -1],
    },
    sqlite: {
      text: 'CASE "u"."status" WHEN ? THEN ? WHEN ? THEN ? ELSE ? END',
      values: ["active", 1, "pending", 0, -1],
    },
  },
  {
    name: "buckets — searched CASE threshold ladder",
    build: () =>
      Expressions.buckets(
        new ColumnExpression("u.score"),
        [
          [90, "gold"],
          [70, "silver"],
        ],
        "bronze",
      ),
    postgres: {
      text:
        'CASE WHEN "u"."score" >= ? THEN ? WHEN "u"."score" >= ? THEN ? ' +
        "ELSE ? END",
      values: [90, "gold", 70, "silver", "bronze"],
    },
    mysql: {
      text:
        "CASE WHEN `u`.`score` >= ? THEN ? WHEN `u`.`score` >= ? THEN ? " +
        "ELSE ? END",
      values: [90, "gold", 70, "silver", "bronze"],
    },
    sqlite: {
      text:
        'CASE WHEN "u"."score" >= ? THEN ? WHEN "u"."score" >= ? THEN ? ' +
        "ELSE ? END",
      values: [90, "gold", 70, "silver", "bronze"],
    },
  },
  {
    name: "iff — two-branch CASE over an IS NULL condition",
    build: () =>
      Expressions.iff(
        new ColumnExpression("u.deletedAt").isNull(),
        "active",
        "deleted",
      ),
    postgres: {
      text: 'CASE WHEN "u"."deletedAt" IS NULL THEN ? ELSE ? END',
      values: ["active", "deleted"],
    },
    mysql: {
      text: "CASE WHEN `u`.`deletedAt` IS NULL THEN ? ELSE ? END",
      values: ["active", "deleted"],
    },
    sqlite: {
      text: 'CASE WHEN "u"."deletedAt" IS NULL THEN ? ELSE ? END',
      values: ["active", "deleted"],
    },
  },
];

const dateCases: GoldenCase[] = [
  {
    name: "dateDiff(second) — epoch / TIMESTAMPDIFF / julianday divergence",
    build: () =>
      Expressions.dateDiff(
        new ColumnExpression("i.completedAt"),
        new ColumnExpression("i.createdAt"),
        "second",
      ),
    postgres: {
      text:
        'CAST(EXTRACT(EPOCH FROM ("i"."completedAt" - "i"."createdAt")) ' +
        "/ ? AS INTEGER)",
      values: [1],
    },
    mysql: {
      text: "TIMESTAMPDIFF(SECOND, `i`.`createdAt`, `i`.`completedAt`)",
      values: [],
    },
    sqlite: {
      text:
        'CAST((julianday("i"."completedAt") - julianday("i"."createdAt")) ' +
        "* ? AS INTEGER)",
      values: [86400],
    },
  },
  {
    name: "dateDiff(year) — calendar-aware on PG/MySQL, approximated on SQLite",
    build: () =>
      Expressions.dateDiff(
        new ColumnExpression("i.completedAt"),
        new ColumnExpression("i.createdAt"),
        "year",
      ),
    postgres: {
      text:
        'CAST(EXTRACT(YEAR FROM age("i"."completedAt", "i"."createdAt")) ' +
        "AS INTEGER)",
      values: [],
    },
    mysql: {
      text: "TIMESTAMPDIFF(YEAR, `i`.`createdAt`, `i`.`completedAt`)",
      values: [],
    },
    sqlite: {
      text:
        'CAST((julianday("i"."completedAt") - julianday("i"."createdAt")) ' +
        "/ 365.25 AS INTEGER)",
      values: [],
    },
  },
  {
    name: "dateTrunc(month)",
    build: () =>
      Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "month"),
    postgres: {
      text: 'date_trunc(?, "i"."completedAt")',
      values: ["month"],
    },
    mysql: {
      text: "DATE_FORMAT(`i`.`completedAt`, '%Y-%m-01')",
      values: [],
    },
    sqlite: {
      text: `date("i"."completedAt", 'start of month')`,
      values: [],
    },
  },
  {
    name: "dateTrunc(week) — ISO-Monday alignment on every dialect",
    build: () =>
      Expressions.dateTrunc(new ColumnExpression("i.completedAt"), "week"),
    postgres: {
      text: 'date_trunc(?, "i"."completedAt")',
      values: ["week"],
    },
    mysql: {
      text:
        "DATE(DATE_SUB(`i`.`completedAt`, " +
        "INTERVAL WEEKDAY(`i`.`completedAt`) DAY))",
      values: [],
    },
    sqlite: {
      text:
        `date("i"."completedAt", '-' || ` +
        `((CAST(strftime('%w', "i"."completedAt") AS INTEGER) + 6) % 7) ` +
        `|| ' days')`,
      values: [],
    },
  },
];

const castAndNullishCases: GoldenCase[] = [
  {
    name: "COALESCE(a, b, literal)",
    build: () =>
      Expressions.coalesce(
        new ColumnExpression("u.nickname"),
        new ColumnExpression("u.name"),
        "anonymous",
      ),
    postgres: {
      text: 'COALESCE("u"."nickname", "u"."name", ?)',
      values: ["anonymous"],
    },
    mysql: {
      text: "COALESCE(`u`.`nickname`, `u`.`name`, ?)",
      values: ["anonymous"],
    },
    sqlite: {
      text: 'COALESCE("u"."nickname", "u"."name", ?)',
      values: ["anonymous"],
    },
  },
  {
    name: "NULLIF(column, literal)",
    build: () => Expressions.nullif(new ColumnExpression("u.email"), ""),
    postgres: { text: 'NULLIF("u"."email", ?)', values: [""] },
    mysql: { text: "NULLIF(`u`.`email`, ?)", values: [""] },
    sqlite: { text: 'NULLIF("u"."email", ?)', values: [""] },
  },
  {
    name: "CAST(... AS <int>) — INTEGER / SIGNED / INTEGER",
    build: () => Expressions.nullif(new ColumnExpression("u.email"), "").intValue(),
    postgres: {
      text: 'CAST(NULLIF("u"."email", ?) AS INTEGER)',
      values: [""],
    },
    mysql: {
      text: "CAST(NULLIF(`u`.`email`, ?) AS SIGNED)",
      values: [""],
    },
    sqlite: {
      text: 'CAST(NULLIF("u"."email", ?) AS INTEGER)',
      values: [""],
    },
  },
  {
    name: "CAST(... AS <string>) — TEXT / CHAR / TEXT",
    build: () =>
      Expressions.coalesce(
        new ColumnExpression("u.nickname"),
        new ColumnExpression("u.name"),
        "anonymous",
      ).stringValue(),
    postgres: {
      text: 'CAST(COALESCE("u"."nickname", "u"."name", ?) AS TEXT)',
      values: ["anonymous"],
    },
    mysql: {
      text: "CAST(COALESCE(`u`.`nickname`, `u`.`name`, ?) AS CHAR)",
      values: ["anonymous"],
    },
    sqlite: {
      text: 'CAST(COALESCE("u"."nickname", "u"."name", ?) AS TEXT)',
      values: ["anonymous"],
    },
  },
];

runGoldenMatrix("golden-sql / CASE expressions", caseCases);
runGoldenMatrix("golden-sql / date arithmetic expressions", dateCases);
runGoldenMatrix("golden-sql / CAST + COALESCE/NULLIF expressions", castAndNullishCases);
