import "reflect-metadata";
import { qAlias } from "../../../src/core/SelectQueryBuilder";
import { createQbFor, User, Department } from "./fixtures";
import { runBuilderGoldenMatrix, type BuilderGoldenCase } from "./harness";

/**
 * Golden SQL — `SelectQueryBuilder` full-statement composition.
 *
 * Pins the assembled SELECT text: clause ordering, JOIN composition, the
 * auto-injected soft-delete filter (`User` carries `@DeletedAt()`), and
 * GROUP BY / HAVING / ORDER BY / LIMIT. Across dialects only identifier
 * quoting changes — MySQL backticks, PostgreSQL and SQLite double quotes —
 * but each expectation is spelled out so a renderer change shows up as a
 * direct diff.
 */

const cases: BuilderGoldenCase[] = [
  {
    name: "bare SELECT — soft-delete filter is auto-injected",
    build: (dialect) => createQbFor(User, "u", dialect).getSql(),
    postgres: {
      text: 'SELECT "u".* FROM "user" AS "u" WHERE "u"."deletedAt" IS NULL',
      values: [],
    },
    mysql: {
      text: "SELECT `u`.* FROM `user` AS `u` WHERE `u`.`deletedAt` IS NULL",
      values: [],
    },
    sqlite: {
      text: 'SELECT "u".* FROM "user" AS "u" WHERE "u"."deletedAt" IS NULL',
      values: [],
    },
  },
  {
    name: "withDeleted() suppresses the soft-delete filter",
    build: (dialect) => createQbFor(User, "u", dialect).withDeleted().getSql(),
    postgres: { text: 'SELECT "u".* FROM "user" AS "u"', values: [] },
    mysql: { text: "SELECT `u`.* FROM `user` AS `u`", values: [] },
    sqlite: { text: 'SELECT "u".* FROM "user" AS "u"', values: [] },
  },
  {
    name: "column projection",
    build: (dialect) =>
      createQbFor(User, "u", dialect).select(["id", "name"]).getSql(),
    postgres: {
      text:
        'SELECT "u"."id", "u"."name" FROM "user" AS "u" ' +
        'WHERE "u"."deletedAt" IS NULL',
      values: [],
    },
    mysql: {
      text:
        "SELECT `u`.`id`, `u`.`name` FROM `user` AS `u` " +
        "WHERE `u`.`deletedAt` IS NULL",
      values: [],
    },
    sqlite: {
      text:
        'SELECT "u"."id", "u"."name" FROM "user" AS "u" ' +
        'WHERE "u"."deletedAt" IS NULL',
      values: [],
    },
  },
  {
    name: "WHERE + andWhere chain, soft-delete filter appended last",
    build: (dialect) => {
      const u = qAlias(User, "u");
      return createQbFor(User, "u", dialect)
        .where(u.age.gte(18))
        .andWhere(u.status.eq("active"))
        .getSql();
    },
    postgres: {
      text:
        'SELECT "u".* FROM "user" AS "u" WHERE "u"."age" >= ? ' +
        'AND "u"."status" = ? AND "u"."deletedAt" IS NULL',
      values: [18, "active"],
    },
    mysql: {
      text:
        "SELECT `u`.* FROM `user` AS `u` WHERE `u`.`age` >= ? " +
        "AND `u`.`status` = ? AND `u`.`deletedAt` IS NULL",
      values: [18, "active"],
    },
    sqlite: {
      text:
        'SELECT "u".* FROM "user" AS "u" WHERE "u"."age" >= ? ' +
        'AND "u"."status" = ? AND "u"."deletedAt" IS NULL',
      values: [18, "active"],
    },
  },
  {
    name: "LEFT JOIN with an ON condition",
    build: (dialect) =>
      createQbFor(User, "u", dialect)
        .leftJoin(Department, "d", (j) => j.on("u.departmentId", "=", "d.id"))
        .getSql(),
    postgres: {
      text:
        'SELECT "u".* FROM "user" AS "u" ' +
        'LEFT JOIN "department" AS "d" ON "u"."departmentId" = "d"."id" ' +
        'WHERE "u"."deletedAt" IS NULL',
      values: [],
    },
    mysql: {
      text:
        "SELECT `u`.* FROM `user` AS `u` " +
        "LEFT JOIN `department` AS `d` ON `u`.`departmentId` = `d`.`id` " +
        "WHERE `u`.`deletedAt` IS NULL",
      values: [],
    },
    sqlite: {
      text:
        'SELECT "u".* FROM "user" AS "u" ' +
        'LEFT JOIN "department" AS "d" ON "u"."departmentId" = "d"."id" ' +
        'WHERE "u"."deletedAt" IS NULL',
      values: [],
    },
  },
  {
    name: "INNER JOIN with an ON condition",
    build: (dialect) =>
      createQbFor(User, "u", dialect)
        .innerJoin(Department, "d", (j) => j.on("u.departmentId", "=", "d.id"))
        .getSql(),
    postgres: {
      text:
        'SELECT "u".* FROM "user" AS "u" ' +
        'INNER JOIN "department" AS "d" ON "u"."departmentId" = "d"."id" ' +
        'WHERE "u"."deletedAt" IS NULL',
      values: [],
    },
    mysql: {
      text:
        "SELECT `u`.* FROM `user` AS `u` " +
        "INNER JOIN `department` AS `d` ON `u`.`departmentId` = `d`.`id` " +
        "WHERE `u`.`deletedAt` IS NULL",
      values: [],
    },
    sqlite: {
      text:
        'SELECT "u".* FROM "user" AS "u" ' +
        'INNER JOIN "department" AS "d" ON "u"."departmentId" = "d"."id" ' +
        'WHERE "u"."deletedAt" IS NULL',
      values: [],
    },
  },
  {
    name: "GROUP BY + HAVING over an aggregate",
    build: (dialect) => {
      const u = qAlias(User, "u");
      return createQbFor(User, "u", dialect)
        .select([u.departmentId.as("dept"), u.id.count().as("cnt")])
        .groupBy(["u.departmentId"])
        .having(u.id.count().gt(5))
        .getSql();
    },
    postgres: {
      text:
        'SELECT "u"."departmentId" AS "dept", COUNT("u"."id") AS "cnt" ' +
        'FROM "user" AS "u" WHERE "u"."deletedAt" IS NULL ' +
        'GROUP BY "u"."departmentId" HAVING COUNT("u"."id") > ?',
      values: [5],
    },
    mysql: {
      text:
        "SELECT `u`.`departmentId` AS `dept`, COUNT(`u`.`id`) AS `cnt` " +
        "FROM `user` AS `u` WHERE `u`.`deletedAt` IS NULL " +
        "GROUP BY `u`.`departmentId` HAVING COUNT(`u`.`id`) > ?",
      values: [5],
    },
    sqlite: {
      text:
        'SELECT "u"."departmentId" AS "dept", COUNT("u"."id") AS "cnt" ' +
        'FROM "user" AS "u" WHERE "u"."deletedAt" IS NULL ' +
        'GROUP BY "u"."departmentId" HAVING COUNT("u"."id") > ?',
      values: [5],
    },
  },
  {
    name: "ORDER BY + LIMIT + OFFSET",
    build: (dialect) =>
      createQbFor(User, "u", dialect)
        .addOrderBy("u.age", "DESC")
        .limit(10)
        .offset(20)
        .getSql(),
    postgres: {
      text:
        'SELECT "u".* FROM "user" AS "u" WHERE "u"."deletedAt" IS NULL ' +
        'ORDER BY "u"."age" DESC LIMIT ? OFFSET ?',
      values: [10, 20],
    },
    mysql: {
      // MySQL uses the `LIMIT <offset>, <count>` form rather than the
      // `LIMIT <count> OFFSET <offset>` standard syntax — note the
      // reversed parameter order.
      text:
        "SELECT `u`.* FROM `user` AS `u` WHERE `u`.`deletedAt` IS NULL " +
        "ORDER BY `u`.`age` DESC LIMIT ?, ?",
      values: [20, 10],
    },
    sqlite: {
      text:
        'SELECT "u".* FROM "user" AS "u" WHERE "u"."deletedAt" IS NULL ' +
        'ORDER BY "u"."age" DESC LIMIT ? OFFSET ?',
      values: [10, 20],
    },
  },
  {
    name: "SELECT DISTINCT",
    build: (dialect) =>
      createQbFor(User, "u", dialect)
        .selectRaw(["u.status"])
        .setDistinct()
        .getSql(),
    postgres: {
      text:
        'SELECT DISTINCT "u"."status" FROM "user" AS "u" ' +
        'WHERE "u"."deletedAt" IS NULL',
      values: [],
    },
    mysql: {
      text:
        "SELECT DISTINCT `u`.`status` FROM `user` AS `u` " +
        "WHERE `u`.`deletedAt` IS NULL",
      values: [],
    },
    sqlite: {
      text:
        'SELECT DISTINCT "u"."status" FROM "user" AS "u" ' +
        'WHERE "u"."deletedAt" IS NULL',
      values: [],
    },
  },
];

runBuilderGoldenMatrix("golden-sql / SelectQueryBuilder", cases);
