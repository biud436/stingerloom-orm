/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Golden SQL — the tenant guard on the upsert conflict branch, per dialect.
 *
 * PostgreSQL and SQLite take one `DO UPDATE … WHERE`; MySQL/MariaDB has no
 * predicate there, so every assignment is individually wrapped in `IF()`.
 * That per-assignment rule is load-bearing: `ON DUPLICATE KEY UPDATE`
 * assignments take effect immediately and are visible to the assignments
 * after them, so one unguarded column would let the rest read an already
 * overwritten tenant value.
 */
import "reflect-metadata";
import sql, { raw } from "../../src/utils/sqlTag";
import { DmlSqlBuilder } from "../../src/core/entity-manager/DmlSqlBuilder";
import type { UpsertTenantGuard } from "../../src/core/entity-manager/WriteExecutor";

type Dialect = "postgres" | "mysql" | "sqlite";

function builderFor(dialect: Dialect): DmlSqlBuilder {
  const quote = dialect === "mysql" ? "`" : '"';
  const ctx: any = {
    isMySqlFamily: () => dialect === "mysql",
    isPostgres: () => dialect === "postgres",
    isSqlite: () => dialect === "sqlite",
    getDbType: () => dialect,
    wrap: (name: string) => `${quote}${name}${quote}`,
  };
  return new DmlSqlBuilder(ctx);
}

/** The predicate `TenantScopeManager.buildTenantWhereClause(entity, table)` emits. */
function guardFor(dialect: Dialect): UpsertTenantGuard {
  const quote = dialect === "mysql" ? "`" : '"';
  const ref = `${quote}orders${quote}`;
  return {
    predicate: sql`${raw(`${ref}.${quote}tenant_id${quote}`)} = ${"acme"}`,
    tableRef: ref,
    columnName: "tenant_id",
  };
}

describe("tenant guard on the upsert conflict branch (golden SQL)", () => {
  const COLUMNS = (d: Dialect) =>
    d === "mysql"
      ? ["`id`", "`slug`", "`amount`", "`tenant_id`"]
      : ['"id"', '"slug"', '"amount"', '"tenant_id"'];
  const CONFLICT = (d: Dialect) => (d === "mysql" ? ["`slug`"] : ['"slug"']);
  const UPDATES = (d: Dialect) =>
    d === "mysql" ? ["`amount`"] : ['"amount"'];
  const TABLE = (d: Dialect) => (d === "mysql" ? "`orders`" : '"orders"');

  describe("single row", () => {
    it("PostgreSQL appends DO UPDATE … WHERE with the table-qualified column", () => {
      const stmt = builderFor("postgres").buildUpsertQuery(
        TABLE("postgres"),
        COLUMNS("postgres"),
        [1, "a", 2, "acme"],
        CONFLICT("postgres"),
        UPDATES("postgres"),
        guardFor("postgres"),
      );

      expect(stmt.sql).toBe(
        'INSERT INTO "orders" ("id", "slug", "amount", "tenant_id") ' +
          "VALUES (?, ?, ?, ?) " +
          'ON CONFLICT ("slug") DO UPDATE SET "amount" = EXCLUDED."amount" ' +
          'WHERE "orders"."tenant_id" = ?',
      );
      expect(stmt.values).toEqual([1, "a", 2, "acme", "acme"]);
    });

    it("SQLite appends the same guard with the lowercase excluded alias", () => {
      const stmt = builderFor("sqlite").buildUpsertQuery(
        TABLE("sqlite"),
        COLUMNS("sqlite"),
        [1, "a", 2, "acme"],
        CONFLICT("sqlite"),
        UPDATES("sqlite"),
        guardFor("sqlite"),
      );

      expect(stmt.sql).toBe(
        'INSERT INTO "orders" ("id", "slug", "amount", "tenant_id") ' +
          "VALUES (?, ?, ?, ?) " +
          'ON CONFLICT ("slug") DO UPDATE SET "amount" = excluded."amount" ' +
          'WHERE "orders"."tenant_id" = ?',
      );
      expect(stmt.values).toEqual([1, "a", 2, "acme", "acme"]);
    });

    it("MySQL guards every assignment with IF(), binding the tenant per column", () => {
      const stmt = builderFor("mysql").buildUpsertQuery(
        TABLE("mysql"),
        COLUMNS("mysql"),
        [1, "a", 2, "acme"],
        CONFLICT("mysql"),
        ["`slug`", "`amount`"],
        guardFor("mysql"),
      );

      expect(stmt.sql).toBe(
        "INSERT INTO `orders` (`id`, `slug`, `amount`, `tenant_id`) " +
          "VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE " +
          "`slug` = IF(`orders`.`tenant_id` = ?, VALUES(`slug`), `orders`.`slug`), " +
          "`amount` = IF(`orders`.`tenant_id` = ?, VALUES(`amount`), `orders`.`amount`)",
      );
      expect(stmt.values).toEqual([1, "a", 2, "acme", "acme", "acme"]);
    });

    it("emits the unguarded statement when no tenant strategy applies", () => {
      const stmt = builderFor("postgres").buildUpsertQuery(
        TABLE("postgres"),
        COLUMNS("postgres"),
        [1, "a", 2, "acme"],
        CONFLICT("postgres"),
        UPDATES("postgres"),
        null,
      );

      expect(stmt.sql).toBe(
        'INSERT INTO "orders" ("id", "slug", "amount", "tenant_id") ' +
          "VALUES (?, ?, ?, ?) " +
          'ON CONFLICT ("slug") DO UPDATE SET "amount" = EXCLUDED."amount"',
      );
      expect(stmt.values).toEqual([1, "a", 2, "acme"]);
    });

    it("degrades to DO NOTHING when the conflict branch has nothing left to write", () => {
      const pg = builderFor("postgres").buildUpsertQuery(
        TABLE("postgres"),
        ['"id"', '"tenant_id"'],
        [1, "acme"],
        ['"id"'],
        [],
        guardFor("postgres"),
      );
      expect(pg.sql).toBe(
        'INSERT INTO "orders" ("id", "tenant_id") VALUES (?, ?) ' +
          'ON CONFLICT ("id") DO NOTHING',
      );

      // MySQL keeps ON DUPLICATE KEY UPDATE with a no-op self-assignment:
      // INSERT IGNORE would also swallow every unrelated error.
      const my = builderFor("mysql").buildUpsertQuery(
        TABLE("mysql"),
        ["`id`", "`tenant_id`"],
        [1, "acme"],
        ["`id`"],
        [],
        guardFor("mysql"),
      );
      expect(my.sql).toBe(
        "INSERT INTO `orders` (`id`, `tenant_id`) VALUES (?, ?) " +
          "ON DUPLICATE KEY UPDATE `id` = `id`",
      );
      expect(my.values).toEqual([1, "acme"]);
    });
  });

  describe("batch", () => {
    const rows = () => [
      sql`(${1}, ${"a"}, ${2}, ${"acme"})`,
      sql`(${2}, ${"b"}, ${3}, ${"acme"})`,
    ];

    it("PostgreSQL guards the whole multi-row DO UPDATE once", () => {
      const stmt = builderFor("postgres").buildBatchUpsertQuery(
        TABLE("postgres"),
        COLUMNS("postgres"),
        rows(),
        CONFLICT("postgres"),
        UPDATES("postgres"),
        guardFor("postgres"),
      );

      expect(stmt.sql).toBe(
        'INSERT INTO "orders" ("id", "slug", "amount", "tenant_id") ' +
          "VALUES (?, ?, ?, ?), (?, ?, ?, ?) " +
          'ON CONFLICT ("slug") DO UPDATE SET "amount" = EXCLUDED."amount" ' +
          'WHERE "orders"."tenant_id" = ?',
      );
      expect(stmt.values).toEqual([1, "a", 2, "acme", 2, "b", 3, "acme", "acme"]);
    });

    it("MySQL guards every assignment of the multi-row statement", () => {
      const stmt = builderFor("mysql").buildBatchUpsertQuery(
        TABLE("mysql"),
        COLUMNS("mysql"),
        rows(),
        CONFLICT("mysql"),
        UPDATES("mysql"),
        guardFor("mysql"),
      );

      expect(stmt.sql).toBe(
        "INSERT INTO `orders` (`id`, `slug`, `amount`, `tenant_id`) " +
          "VALUES (?, ?, ?, ?), (?, ?, ?, ?) ON DUPLICATE KEY UPDATE " +
          "`amount` = IF(`orders`.`tenant_id` = ?, VALUES(`amount`), `orders`.`amount`)",
      );
      expect(stmt.values).toEqual([1, "a", 2, "acme", 2, "b", 3, "acme", "acme"]);
    });

    it("degrades a batch with an empty update list to DO NOTHING / INSERT IGNORE", () => {
      const pg = builderFor("postgres").buildBatchUpsertQuery(
        TABLE("postgres"),
        ['"id"', '"tenant_id"'],
        [sql`(${1}, ${"acme"})`],
        ['"id"'],
        [],
        guardFor("postgres"),
      );
      expect(pg.sql).toBe(
        'INSERT INTO "orders" ("id", "tenant_id") VALUES (?, ?) ' +
          'ON CONFLICT ("id") DO NOTHING',
      );

      const my = builderFor("mysql").buildBatchUpsertQuery(
        TABLE("mysql"),
        ["`id`", "`tenant_id`"],
        [sql`(${1}, ${"acme"})`],
        ["`id`"],
        [],
        guardFor("mysql"),
      );
      expect(my.sql).toBe(
        "INSERT INTO `orders` (`id`, `tenant_id`) VALUES (?, ?) " +
          "ON DUPLICATE KEY UPDATE `id` = `id`",
      );
    });
  });
});
