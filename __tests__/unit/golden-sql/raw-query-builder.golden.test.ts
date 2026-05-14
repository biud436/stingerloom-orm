import "reflect-metadata";
import sql from "sql-template-tag";
import { RawQueryBuilderFactory } from "../../../src/core/RawQueryBuilderFactory";
import { Conditions } from "../../../src/core/Conditions";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import {
  runBuilderGoldenMatrix,
  type BuilderGoldenCase,
  type DialectName,
} from "./harness";

/**
 * Golden SQL — `RawQueryBuilder` advanced clauses: CTE / WITH RECURSIVE,
 * window functions, set operations, and PostgreSQL `DISTINCT ON`.
 *
 * Most raw clauses are dialect-agnostic (identifiers pass through
 * verbatim), but `selectWithWindow()` escapes identifiers per dialect and
 * `selectDistinctOn()` is PostgreSQL-only — those carry the divergence
 * this matrix locks down.
 */

/** Map a golden `DialectName` to `RawQueryBuilder`'s `DatabaseType`. */
function rawDbType(dialect: DialectName): "mysql" | "postgresql" | "sqlite" {
  return dialect === "postgres" ? "postgresql" : dialect;
}

const cases: BuilderGoldenCase[] = [
  {
    name: "CTE — single WITH clause, inner bindings preserved",
    build: (dialect) => {
      const q = RawQueryBuilderFactory.create()
        .setDatabaseType(rawDbType(dialect))
        .with("active", (qb) =>
          qb
            .select(["id", "name"])
            .from("users")
            .where([Conditions.equals("active", true)]),
        )
        .select("*")
        .from("active")
        .build();
      return { text: q.sql, values: q.values };
    },
    postgres: {
      text:
        "WITH active AS (SELECT id, name FROM users WHERE active = ?) " +
        "SELECT * FROM active",
      values: [true],
    },
    mysql: {
      text:
        "WITH active AS (SELECT id, name FROM users WHERE active = ?) " +
        "SELECT * FROM active",
      values: [true],
    },
    sqlite: {
      text:
        "WITH active AS (SELECT id, name FROM users WHERE active = ?) " +
        "SELECT * FROM active",
      values: [true],
    },
  },
  {
    name: "WITH RECURSIVE — seed UNION ALL step body",
    build: (dialect) => {
      const q = RawQueryBuilderFactory.create()
        .setDatabaseType(rawDbType(dialect))
        .withRecursive("tree", (qb) =>
          qb
            .select(["id", "parent_id", "0 AS depth"])
            .from("issue")
            .where([Conditions.equals("id", 1)])
            .unionAll()
            .selectFragments([
              sql`c.id`,
              sql`c.parent_id`,
              sql`t.depth + 1`,
            ])
            .from("issue", "c")
            .innerJoin("tree", "t", sql`c.parent_id = t.id`)
            .where([sql`t.depth < ${10}`]),
        )
        .select("*")
        .from("tree")
        .build();
      return { text: q.sql, values: q.values };
    },
    postgres: {
      text:
        "WITH RECURSIVE tree AS (" +
        "SELECT id, parent_id, 0 AS depth FROM issue WHERE id = ? " +
        "UNION ALL " +
        "SELECT c.id, c.parent_id, t.depth + 1 FROM issue AS c " +
        "INNER JOIN tree AS t ON c.parent_id = t.id " +
        "WHERE t.depth < ?" +
        ") SELECT * FROM tree",
      values: [1, 10],
    },
    mysql: {
      text:
        "WITH RECURSIVE tree AS (" +
        "SELECT id, parent_id, 0 AS depth FROM issue WHERE id = ? " +
        "UNION ALL " +
        "SELECT c.id, c.parent_id, t.depth + 1 FROM issue AS c " +
        "INNER JOIN tree AS t ON c.parent_id = t.id " +
        "WHERE t.depth < ?" +
        ") SELECT * FROM tree",
      values: [1, 10],
    },
    sqlite: {
      text:
        "WITH RECURSIVE tree AS (" +
        "SELECT id, parent_id, 0 AS depth FROM issue WHERE id = ? " +
        "UNION ALL " +
        "SELECT c.id, c.parent_id, t.depth + 1 FROM issue AS c " +
        "INNER JOIN tree AS t ON c.parent_id = t.id " +
        "WHERE t.depth < ?" +
        ") SELECT * FROM tree",
      values: [1, 10],
    },
  },
  {
    name: "window function — identifiers escaped per dialect",
    build: (dialect) => {
      const q = RawQueryBuilderFactory.create()
        .setDatabaseType(rawDbType(dialect))
        .selectWithWindow([
          "name",
          "salary",
          {
            expr: "ROW_NUMBER()",
            over: { partitionBy: "department", orderBy: "salary DESC" },
            alias: "rank",
          },
        ])
        .from("employees")
        .build();
      return { text: q.sql, values: q.values };
    },
    postgres: {
      text:
        'SELECT "name", "salary", ROW_NUMBER() OVER ' +
        '(PARTITION BY "department" ORDER BY "salary" DESC) AS "rank" ' +
        "FROM employees",
      values: [],
    },
    mysql: {
      text:
        "SELECT `name`, `salary`, ROW_NUMBER() OVER " +
        "(PARTITION BY `department` ORDER BY `salary` DESC) AS `rank` " +
        "FROM employees",
      values: [],
    },
    sqlite: {
      text:
        'SELECT "name", "salary", ROW_NUMBER() OVER ' +
        '(PARTITION BY "department" ORDER BY "salary" DESC) AS "rank" ' +
        "FROM employees",
      values: [],
    },
  },
  {
    name: "set operation — UNION",
    build: (dialect) => {
      const q = RawQueryBuilderFactory.create()
        .setDatabaseType(rawDbType(dialect))
        .select(["name"])
        .from("active_users")
        .union()
        .select(["name"])
        .from("archived_users")
        .build();
      return { text: q.sql, values: q.values };
    },
    postgres: {
      text: "SELECT name FROM active_users UNION SELECT name FROM archived_users",
      values: [],
    },
    mysql: {
      text: "SELECT name FROM active_users UNION SELECT name FROM archived_users",
      values: [],
    },
    sqlite: {
      text: "SELECT name FROM active_users UNION SELECT name FROM archived_users",
      values: [],
    },
  },
  {
    name: "set operation — UNION ALL",
    build: (dialect) => {
      const q = RawQueryBuilderFactory.create()
        .setDatabaseType(rawDbType(dialect))
        .select(["id"])
        .from("table_a")
        .unionAll()
        .select(["id"])
        .from("table_b")
        .build();
      return { text: q.sql, values: q.values };
    },
    postgres: {
      text: "SELECT id FROM table_a UNION ALL SELECT id FROM table_b",
      values: [],
    },
    mysql: {
      text: "SELECT id FROM table_a UNION ALL SELECT id FROM table_b",
      values: [],
    },
    sqlite: {
      text: "SELECT id FROM table_a UNION ALL SELECT id FROM table_b",
      values: [],
    },
  },
  {
    name: "set operation — INTERSECT",
    build: (dialect) => {
      const q = RawQueryBuilderFactory.create()
        .setDatabaseType(rawDbType(dialect))
        .select(["email"])
        .from("subscribers")
        .intersect()
        .select(["email"])
        .from("customers")
        .build();
      return { text: q.sql, values: q.values };
    },
    postgres: {
      text:
        "SELECT email FROM subscribers INTERSECT SELECT email FROM customers",
      values: [],
    },
    mysql: {
      text:
        "SELECT email FROM subscribers INTERSECT SELECT email FROM customers",
      values: [],
    },
    sqlite: {
      text:
        "SELECT email FROM subscribers INTERSECT SELECT email FROM customers",
      values: [],
    },
  },
  {
    name: "set operation — EXCEPT",
    build: (dialect) => {
      const q = RawQueryBuilderFactory.create()
        .setDatabaseType(rawDbType(dialect))
        .select(["id"])
        .from("all_users")
        .except()
        .select(["id"])
        .from("banned_users")
        .build();
      return { text: q.sql, values: q.values };
    },
    postgres: {
      text: "SELECT id FROM all_users EXCEPT SELECT id FROM banned_users",
      values: [],
    },
    mysql: {
      text: "SELECT id FROM all_users EXCEPT SELECT id FROM banned_users",
      values: [],
    },
    sqlite: {
      text: "SELECT id FROM all_users EXCEPT SELECT id FROM banned_users",
      values: [],
    },
  },
  {
    name: "DISTINCT ON — PostgreSQL only, rejected elsewhere",
    build: (dialect) => {
      const q = RawQueryBuilderFactory.create()
        .setDatabaseType(rawDbType(dialect))
        .selectDistinctOn(["customer_id"], "*")
        .from("orders")
        .orderBy([{ column: "customer_id", direction: "ASC" }])
        .build();
      return { text: q.sql, values: q.values };
    },
    postgres: {
      text:
        "SELECT DISTINCT ON (customer_id) * FROM orders " +
        "ORDER BY customer_id ASC",
      values: [],
    },
    mysql: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
    sqlite: { throws: OrmErrorCode.UNSUPPORTED_OPERATION },
  },
];

runBuilderGoldenMatrix("golden-sql / RawQueryBuilder", cases);
