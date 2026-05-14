import "reflect-metadata";
import sql, { type Sql } from "sql-template-tag";
import { Expressions } from "../../../src/core/expressions/LogicalCondition";
import { makeJsonPathExpression } from "../../../src/core/expressions/JsonPathExpression";
import { runGoldenMatrix, type GoldenCase } from "./harness";

/**
 * Golden SQL — JSON path conditions + EXISTS subquery conditions.
 *
 * JSON access is where the three drivers diverge the most: PostgreSQL uses
 * native `->` / `#>>` operators, MySQL uses `JSON_EXTRACT` with a `$.path`
 * string, SQLite uses `json_extract`. EXISTS rendering is dialect-agnostic
 * but must preserve the inner subquery's bound parameters.
 */

/**
 * Minimal `SelectQueryBuilder`-like stub: `Expressions.exists()` only needs
 * an object exposing `toSql()` + `getSql()` (duck-typed via `isSubqueryLike`).
 */
function fakeSubquery(fragment: Sql): { toSql(): Sql; getSql(): unknown } {
  return {
    toSql: () => fragment,
    getSql: () => ({ text: fragment.sql, values: fragment.values }),
  };
}

const jsonCases: GoldenCase[] = [
  {
    name: "single-segment path equality",
    build: () =>
      makeJsonPathExpression("u.profile", []).path("role").eq("admin"),
    postgres: {
      text: '"u"."profile" ->> ? = ?',
      values: ["role", "admin"],
    },
    mysql: {
      text: "JSON_UNQUOTE(JSON_EXTRACT(`u`.`profile`, ?)) = ?",
      values: ["$.role", "admin"],
    },
    sqlite: {
      text: 'json_extract("u"."profile", ?) = ?',
      values: ["$.role", "admin"],
    },
  },
  {
    name: "multi-segment path equality",
    build: () =>
      makeJsonPathExpression("u.profile", [])
        .path("address.city")
        .eq("Seoul"),
    postgres: {
      text: '"u"."profile" #>> ARRAY[?, ?]::text[] = ?',
      values: ["address", "city", "Seoul"],
    },
    mysql: {
      text: "JSON_UNQUOTE(JSON_EXTRACT(`u`.`profile`, ?)) = ?",
      values: ["$.address.city", "Seoul"],
    },
    sqlite: {
      text: 'json_extract("u"."profile", ?) = ?',
      values: ["$.address.city", "Seoul"],
    },
  },
  {
    name: "hasKey at the document root",
    build: () => makeJsonPathExpression("u.profile", []).hasKey("email"),
    postgres: {
      text: 'jsonb_exists("u"."profile", ?)',
      values: ["email"],
    },
    mysql: {
      text: "JSON_CONTAINS_PATH(`u`.`profile`, 'one', ?)",
      values: ["$.email"],
    },
    sqlite: {
      text: 'json_extract("u"."profile", ?) IS NOT NULL',
      values: ["$.email"],
    },
  },
  {
    name: "arrayLength comparison",
    build: () =>
      makeJsonPathExpression("u.profile", [])
        .path("tags")
        .arrayLength()
        .gte(3),
    postgres: {
      text: 'jsonb_array_length("u"."profile" -> ?) >= ?',
      values: ["tags", 3],
    },
    mysql: {
      text: "JSON_LENGTH(`u`.`profile`, ?) >= ?",
      values: ["$.tags", 3],
    },
    sqlite: {
      text: 'json_array_length("u"."profile", ?) >= ?',
      values: ["$.tags", 3],
    },
  },
  {
    name: "path IS NULL",
    build: () =>
      makeJsonPathExpression("u.profile", []).path("deletedAt").isNull(),
    postgres: {
      text: '"u"."profile" ->> ? IS NULL',
      values: ["deletedAt"],
    },
    mysql: {
      text: "JSON_UNQUOTE(JSON_EXTRACT(`u`.`profile`, ?)) IS NULL",
      values: ["$.deletedAt"],
    },
    sqlite: {
      text: 'json_extract("u"."profile", ?) IS NULL',
      values: ["$.deletedAt"],
    },
  },
];

const subqueryCases: GoldenCase[] = [
  {
    name: "EXISTS (subquery) — inner bindings preserved",
    build: () =>
      Expressions.exists(
        fakeSubquery(sql`SELECT "p"."id" FROM "post" WHERE "p"."views" = ${5}`),
      ),
    postgres: {
      text: 'EXISTS (SELECT "p"."id" FROM "post" WHERE "p"."views" = ?)',
      values: [5],
    },
    mysql: {
      text: 'EXISTS (SELECT "p"."id" FROM "post" WHERE "p"."views" = ?)',
      values: [5],
    },
    sqlite: {
      text: 'EXISTS (SELECT "p"."id" FROM "post" WHERE "p"."views" = ?)',
      values: [5],
    },
  },
  {
    name: "NOT EXISTS (subquery)",
    build: () =>
      Expressions.notExists(
        fakeSubquery(sql`SELECT 1 FROM "ban" WHERE "ban"."user_id" = ${42}`),
      ),
    postgres: {
      text: 'NOT EXISTS (SELECT 1 FROM "ban" WHERE "ban"."user_id" = ?)',
      values: [42],
    },
    mysql: {
      text: 'NOT EXISTS (SELECT 1 FROM "ban" WHERE "ban"."user_id" = ?)',
      values: [42],
    },
    sqlite: {
      text: 'NOT EXISTS (SELECT 1 FROM "ban" WHERE "ban"."user_id" = ?)',
      values: [42],
    },
  },
];

runGoldenMatrix("golden-sql / JSON path conditions", jsonCases);
runGoldenMatrix("golden-sql / EXISTS subquery conditions", subqueryCases);
