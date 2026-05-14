import "reflect-metadata";
import { Expressions } from "../../../src/core/expressions/LogicalCondition";
import { ColumnExpression } from "../../../src/core/SelectQueryBuilder";
import { runGoldenMatrix, type GoldenCase } from "./harness";

/**
 * Golden SQL — window expressions (`<head> OVER (...)`).
 *
 * Window rendering itself is dialect-agnostic; only identifier quoting
 * differs across drivers. These cases pin the OVER-clause composition
 * (PARTITION BY / ORDER BY / frame) and the function-head shapes.
 */

const cases: GoldenCase[] = [
  {
    name: "ROW_NUMBER() with PARTITION BY + ORDER BY DESC",
    build: () =>
      Expressions.rowNumber()
        .partitionBy(new ColumnExpression("u.teamId"))
        .orderBy(new ColumnExpression("u.score").desc())
        .as("rn"),
    postgres: {
      text:
        'ROW_NUMBER() OVER (PARTITION BY "u"."teamId" ' +
        'ORDER BY "u"."score" DESC)',
      values: [],
    },
    mysql: {
      text:
        "ROW_NUMBER() OVER (PARTITION BY `u`.`teamId` " +
        "ORDER BY `u`.`score` DESC)",
      values: [],
    },
    sqlite: {
      text:
        'ROW_NUMBER() OVER (PARTITION BY "u"."teamId" ' +
        'ORDER BY "u"."score" DESC)',
      values: [],
    },
  },
  {
    name: "RANK() with an empty OVER clause",
    build: () => Expressions.rank().as("r"),
    postgres: { text: "RANK() OVER ()", values: [] },
    mysql: { text: "RANK() OVER ()", values: [] },
    sqlite: { text: "RANK() OVER ()", values: [] },
  },
  {
    name: "NTILE(n) binds the bucket count as a parameter",
    build: () =>
      Expressions.ntile(4)
        .orderBy(new ColumnExpression("u.score").desc())
        .as("quartile"),
    postgres: {
      text: 'NTILE(?) OVER (ORDER BY "u"."score" DESC)',
      values: [4],
    },
    mysql: {
      text: "NTILE(?) OVER (ORDER BY `u`.`score` DESC)",
      values: [4],
    },
    sqlite: {
      text: 'NTILE(?) OVER (ORDER BY "u"."score" DESC)',
      values: [4],
    },
  },
  {
    name: "LAG(expr, offset, default) — three-argument form",
    build: () =>
      Expressions.lag(new ColumnExpression("a.value"), 2, 0)
        .partitionBy(new ColumnExpression("a.issueId"))
        .orderBy(new ColumnExpression("a.createdAt").asc())
        .as("prev"),
    postgres: {
      text:
        'LAG("a"."value", ?, ?) OVER (PARTITION BY "a"."issueId" ' +
        'ORDER BY "a"."createdAt" ASC)',
      values: [2, 0],
    },
    mysql: {
      text:
        "LAG(`a`.`value`, ?, ?) OVER (PARTITION BY `a`.`issueId` " +
        "ORDER BY `a`.`createdAt` ASC)",
      values: [2, 0],
    },
    sqlite: {
      text:
        'LAG("a"."value", ?, ?) OVER (PARTITION BY "a"."issueId" ' +
        'ORDER BY "a"."createdAt" ASC)',
      values: [2, 0],
    },
  },
  {
    name: "Aggregate-as-window — SUM(col) OVER (PARTITION BY ... ROWS BETWEEN ...)",
    build: () =>
      new ColumnExpression("u.score")
        .sum()
        .over()
        .partitionBy(new ColumnExpression("u.teamId"))
        .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
        .as("running_total"),
    postgres: {
      text:
        'SUM("u"."score") OVER (PARTITION BY "u"."teamId" ' +
        "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)",
      values: [],
    },
    mysql: {
      text:
        "SUM(`u`.`score`) OVER (PARTITION BY `u`.`teamId` " +
        "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)",
      values: [],
    },
    sqlite: {
      text:
        'SUM("u"."score") OVER (PARTITION BY "u"."teamId" ' +
        "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)",
      values: [],
    },
  },
  {
    name: "FIRST_VALUE(expr) OVER (ORDER BY ... RANGE BETWEEN ...)",
    build: () =>
      Expressions.firstValue(new ColumnExpression("i.amount"))
        .orderBy(new ColumnExpression("i.createdAt").asc())
        .rangeBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
        .as("running_first"),
    postgres: {
      text:
        'FIRST_VALUE("i"."amount") OVER (ORDER BY "i"."createdAt" ASC ' +
        "RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)",
      values: [],
    },
    mysql: {
      text:
        "FIRST_VALUE(`i`.`amount`) OVER (ORDER BY `i`.`createdAt` ASC " +
        "RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)",
      values: [],
    },
    sqlite: {
      text:
        'FIRST_VALUE("i"."amount") OVER (ORDER BY "i"."createdAt" ASC ' +
        "RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)",
      values: [],
    },
  },
];

runGoldenMatrix("golden-sql / window expressions", cases);
