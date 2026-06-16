import "reflect-metadata";
import { ColumnExpression } from "../../../src/core/SelectQueryBuilder";
import { runGoldenMatrix, type GoldenCase } from "./harness";

/**
 * Golden SQL — `.matches()` regex predicates. PostgreSQL uses `~`; MySQL and
 * SQLite use `REGEXP` (SQLite via the connector's `regexp` UDF). Flags are
 * carried as an inline `(?ims)` prefix on the bound pattern, so the pattern
 * is always a single parameter — never interpolated into the SQL text.
 */
const regexCases: GoldenCase[] = [
  {
    name: "string pattern — bound, not interpolated",
    build: () => new ColumnExpression("u.email").matches("^admin@"),
    postgres: { text: '"u"."email" ~ ?', values: ["^admin@"] },
    mysql: { text: "`u`.`email` REGEXP ?", values: ["^admin@"] },
    sqlite: { text: '"u"."email" REGEXP ?', values: ["^admin@"] },
  },
  {
    name: "RegExp with i flag → (?i) inline prefix",
    build: () => new ColumnExpression("u.title").matches(/typescript/i),
    postgres: { text: '"u"."title" ~ ?', values: ["(?i)typescript"] },
    mysql: { text: "`u`.`title` REGEXP ?", values: ["(?i)typescript"] },
    sqlite: { text: '"u"."title" REGEXP ?', values: ["(?i)typescript"] },
  },
  {
    name: "RegExp with m flag → (?m) inline prefix",
    build: () => new ColumnExpression("u.body").matches(/^line$/m),
    postgres: { text: '"u"."body" ~ ?', values: ["(?m)^line$"] },
    mysql: { text: "`u`.`body` REGEXP ?", values: ["(?m)^line$"] },
    sqlite: { text: '"u"."body" REGEXP ?', values: ["(?m)^line$"] },
  },
  {
    name: "RegExp with i+m+s flags → (?ims) inline prefix",
    build: () => new ColumnExpression("u.body").matches(/a.b/ims),
    postgres: { text: '"u"."body" ~ ?', values: ["(?ims)a.b"] },
    mysql: { text: "`u`.`body` REGEXP ?", values: ["(?ims)a.b"] },
    sqlite: { text: '"u"."body" REGEXP ?', values: ["(?ims)a.b"] },
  },
  {
    name: ".not() wraps with NOT (...)",
    build: () => new ColumnExpression("u.email").matches("^admin@").not(),
    postgres: { text: 'NOT ("u"."email" ~ ?)', values: ["^admin@"] },
    mysql: { text: "NOT (`u`.`email` REGEXP ?)", values: ["^admin@"] },
    sqlite: { text: 'NOT ("u"."email" REGEXP ?)', values: ["^admin@"] },
  },
  {
    name: "composed with AND",
    build: () =>
      new ColumnExpression("u.email")
        .matches("@example\\.com$")
        .and(new ColumnExpression("u.age").gte(18)),
    postgres: {
      text: '("u"."email" ~ ? AND "u"."age" >= ?)',
      values: ["@example\\.com$", 18],
    },
    mysql: {
      text: "(`u`.`email` REGEXP ? AND `u`.`age` >= ?)",
      values: ["@example\\.com$", 18],
    },
    sqlite: {
      text: '("u"."email" REGEXP ? AND "u"."age" >= ?)',
      values: ["@example\\.com$", 18],
    },
  },
];

runGoldenMatrix("golden-sql / regex (.matches) expressions", regexCases);
