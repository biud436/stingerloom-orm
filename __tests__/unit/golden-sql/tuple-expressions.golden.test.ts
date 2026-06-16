import "reflect-metadata";
import { Expressions } from "../../../src/core/expressions/LogicalCondition";
import { runGoldenMatrix, type GoldenCase } from "./harness";

/**
 * Golden SQL — row-value (tuple) comparisons. The clause is native and
 * identical across all three dialects; only identifier quoting differs
 * (backticks on MySQL, double quotes on PostgreSQL/SQLite).
 */
const tupleCases: GoldenCase[] = [
  {
    name: "(a, b) IN ((?, ?), (?, ?))",
    build: () =>
      Expressions.tuple("u.tenantId", "u.userId").in([
        [1, "alice"],
        [1, "bob"],
      ]),
    postgres: {
      text: '("u"."tenantId", "u"."userId") IN ((?, ?), (?, ?))',
      values: [1, "alice", 1, "bob"],
    },
    mysql: {
      text: "(`u`.`tenantId`, `u`.`userId`) IN ((?, ?), (?, ?))",
      values: [1, "alice", 1, "bob"],
    },
    sqlite: {
      text: '("u"."tenantId", "u"."userId") IN ((?, ?), (?, ?))',
      values: [1, "alice", 1, "bob"],
    },
  },
  {
    name: "(a, b) NOT IN ((?, ?))",
    build: () =>
      Expressions.tuple("u.tenantId", "u.userId").notIn([[2, "carol"]]),
    postgres: {
      text: '("u"."tenantId", "u"."userId") NOT IN ((?, ?))',
      values: [2, "carol"],
    },
    mysql: {
      text: "(`u`.`tenantId`, `u`.`userId`) NOT IN ((?, ?))",
      values: [2, "carol"],
    },
    sqlite: {
      text: '("u"."tenantId", "u"."userId") NOT IN ((?, ?))',
      values: [2, "carol"],
    },
  },
  {
    name: "(a, b) = (?, ?)",
    build: () => Expressions.tuple("u.a", "u.b").eq([1, 2]),
    postgres: { text: '("u"."a", "u"."b") = (?, ?)', values: [1, 2] },
    mysql: { text: "(`u`.`a`, `u`.`b`) = (?, ?)", values: [1, 2] },
    sqlite: { text: '("u"."a", "u"."b") = (?, ?)', values: [1, 2] },
  },
  {
    name: "single-column tuple — (a) IN ((?), (?))",
    build: () => Expressions.tuple("u.id").in([[1], [2]]),
    postgres: { text: '("u"."id") IN ((?), (?))', values: [1, 2] },
    mysql: { text: "(`u`.`id`) IN ((?), (?))", values: [1, 2] },
    sqlite: { text: '("u"."id") IN ((?), (?))', values: [1, 2] },
  },
  {
    name: "empty IN list degenerates to 1 = 0 (match nothing)",
    build: () => Expressions.tuple("u.a", "u.b").in([]),
    postgres: { text: "1 = 0", values: [] },
    mysql: { text: "1 = 0", values: [] },
    sqlite: { text: "1 = 0", values: [] },
  },
  {
    name: "empty NOT IN list degenerates to 1 = 1 (exclude nothing)",
    build: () => Expressions.tuple("u.a", "u.b").notIn([]),
    postgres: { text: "1 = 1", values: [] },
    mysql: { text: "1 = 1", values: [] },
    sqlite: { text: "1 = 1", values: [] },
  },
];

runGoldenMatrix("golden-sql / tuple (row-value) expressions", tupleCases);
