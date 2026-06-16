import "reflect-metadata";
import { ColumnExpression } from "../../../src/core/SelectQueryBuilder";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { runGoldenMatrix, type GoldenCase } from "./harness";

/**
 * Golden SQL — PostgreSQL array operators. `@>` / `&&` / `<@` are
 * PostgreSQL-only; MySQL and SQLite reject them with
 * `OrmErrorCode.UNSUPPORTED_DATABASE` (no native array column type). The
 * value array is bound as a single parameter (node-postgres serializes it).
 */
const arrayCases: GoldenCase[] = [
  {
    name: "arrayContains → @>",
    build: () =>
      new ColumnExpression("u.tags").arrayContains(["admin", "beta"]),
    postgres: {
      text: '"u"."tags" @> ?',
      values: [["admin", "beta"]],
    },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
  },
  {
    name: "arrayOverlaps → &&",
    build: () => new ColumnExpression("u.tags").arrayOverlaps(["vip", "pro"]),
    postgres: { text: '"u"."tags" && ?', values: [["vip", "pro"]] },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
  },
  {
    name: "arrayContainedBy → <@",
    build: () =>
      new ColumnExpression("u.tags").arrayContainedBy(["a", "b", "c"]),
    postgres: { text: '"u"."tags" <@ ?', values: [["a", "b", "c"]] },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
  },
  {
    name: "arrayContains with numbers",
    build: () => new ColumnExpression("u.ids").arrayContains([1, 2, 3]),
    postgres: { text: '"u"."ids" @> ?', values: [[1, 2, 3]] },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
  },
  {
    name: "empty array binds as one param (no ARRAY[] cast issue)",
    build: () => new ColumnExpression("u.tags").arrayContains([]),
    postgres: { text: '"u"."tags" @> ?', values: [[]] },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
  },
  {
    name: ".not() wraps with NOT (...)",
    build: () =>
      new ColumnExpression("u.tags").arrayContains(["admin"]).not(),
    postgres: { text: 'NOT ("u"."tags" @> ?)', values: [["admin"]] },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
  },
];

runGoldenMatrix("golden-sql / PostgreSQL array operators", arrayCases);
