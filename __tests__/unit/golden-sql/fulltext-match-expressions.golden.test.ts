import "reflect-metadata";
import { ColumnExpression } from "../../../src/core/SelectQueryBuilder";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { runGoldenMatrix, type GoldenCase } from "./harness";

/**
 * Golden SQL — `.matchAgainst()` full-text predicates. PostgreSQL composes a
 * `to_tsvector @@ plainto_tsquery` pipeline; MySQL emits `MATCH … AGAINST`;
 * SQLite rejects it (no FTS via the query builder — use FTS5 + raw SQL). The
 * query string is always bound as a parameter.
 */
const matchCases: GoldenCase[] = [
  {
    name: "default — boolean mode (MySQL), english config (PostgreSQL)",
    build: () => new ColumnExpression("a.body").matchAgainst("typescript orm"),
    postgres: {
      text: 'to_tsvector(?, "a"."body") @@ plainto_tsquery(?, ?)',
      values: ["english", "english", "typescript orm"],
    },
    mysql: {
      text: "MATCH(`a`.`body`) AGAINST(? IN BOOLEAN MODE)",
      values: ["typescript orm"],
    },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
  },
  {
    name: "natural language mode (MySQL)",
    build: () =>
      new ColumnExpression("a.body").matchAgainst("orm", { mode: "natural" }),
    postgres: {
      text: 'to_tsvector(?, "a"."body") @@ plainto_tsquery(?, ?)',
      values: ["english", "english", "orm"],
    },
    mysql: {
      text: "MATCH(`a`.`body`) AGAINST(? IN NATURAL LANGUAGE MODE)",
      values: ["orm"],
    },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
  },
  {
    name: "custom language (PostgreSQL)",
    build: () =>
      new ColumnExpression("a.body").matchAgainst("bonjour", {
        language: "french",
      }),
    postgres: {
      text: 'to_tsvector(?, "a"."body") @@ plainto_tsquery(?, ?)',
      values: ["french", "french", "bonjour"],
    },
    mysql: {
      text: "MATCH(`a`.`body`) AGAINST(? IN BOOLEAN MODE)",
      values: ["bonjour"],
    },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
  },
  {
    name: ".not() wraps with NOT (...)",
    build: () => new ColumnExpression("a.body").matchAgainst("spam").not(),
    postgres: {
      text: 'NOT (to_tsvector(?, "a"."body") @@ plainto_tsquery(?, ?))',
      values: ["english", "english", "spam"],
    },
    mysql: {
      text: "NOT (MATCH(`a`.`body`) AGAINST(? IN BOOLEAN MODE))",
      values: ["spam"],
    },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_DATABASE },
  },
];

runGoldenMatrix("golden-sql / full-text (.matchAgainst) expressions", matchCases);
