/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Golden SQL — the ORM-managed assignments of the upsert conflict branch,
 * per dialect (V6-T0-4).
 *
 * - `@Version` counts up from the stored row. PostgreSQL requires the stored
 *   column to be table-qualified (a bare one is ambiguous against
 *   `EXCLUDED`), and the qualifier is the bare table name even when the
 *   target is schema-qualified.
 * - On MySQL/MariaDB every managed assignment goes through the tenant `IF()`
 *   like the caller's columns; an unwrapped `version + 1` or `deleted_at =
 *   NULL` would write a foreign row.
 * - With nothing of the caller's to update, only the `@DeletedAt` reset
 *   survives, limited to a soft-deleted row on PostgreSQL/SQLite.
 */
import "reflect-metadata";
import sql, { raw } from "../../src/utils/sqlTag";
import {
  DmlSqlBuilder,
  type UpsertManagedAssignments,
} from "../../src/core/entity-manager/DmlSqlBuilder";
import type { UpsertTenantGuard } from "../../src/core/entity-manager/WriteExecutor";

type Dialect = "postgres" | "mysql" | "sqlite";

const q = (d: Dialect, name: string) =>
  d === "mysql" ? `\`${name}\`` : `"${name}"`;

function builderFor(dialect: Dialect): DmlSqlBuilder {
  const ctx: any = {
    isMySqlFamily: () => dialect === "mysql",
    isPostgres: () => dialect === "postgres",
    isSqlite: () => dialect === "sqlite",
    getDbType: () => dialect,
    wrap: (name: string) => q(dialect, name),
  };
  return new DmlSqlBuilder(ctx);
}

function guardFor(d: Dialect): UpsertTenantGuard {
  return {
    predicate: sql`${raw(`${q(d, "orders")}.${q(d, "tenant_id")}`)} = ${"acme"}`,
    tableRef: q(d, "orders"),
    columnName: "tenant_id",
  };
}

function managedFor(
  d: Dialect,
  overrides: Partial<UpsertManagedAssignments> = {},
): UpsertManagedAssignments {
  return {
    existingRowRef: q(d, "orders"),
    refresh: [q(d, "updated_at")],
    increment: [q(d, "version")],
    reset: [q(d, "deleted_at")],
    ...overrides,
  };
}

const COLUMNS = (d: Dialect) =>
  ["slug", "hits", "version", "created_at", "updated_at"].map((c) => q(d, c));
const VALUES = ["a", 5, 1, "now", "now"];

describe("upsert conflict branch — managed columns (golden SQL)", () => {
  describe("single row", () => {
    it("PostgreSQL: caller columns, then updated_at, version from the stored row, deleted_at reset", () => {
      const stmt = builderFor("postgres").buildUpsertQuery(
        '"orders"',
        COLUMNS("postgres"),
        VALUES,
        ['"slug"'],
        ['"hits"'],
        null,
        managedFor("postgres"),
      );

      expect(stmt.sql).toBe(
        'INSERT INTO "orders" ("slug", "hits", "version", "created_at", "updated_at") ' +
          "VALUES (?, ?, ?, ?, ?) " +
          'ON CONFLICT ("slug") DO UPDATE SET "hits" = EXCLUDED."hits", ' +
          '"updated_at" = EXCLUDED."updated_at", ' +
          '"version" = COALESCE("orders"."version", 0) + 1, ' +
          '"deleted_at" = NULL',
      );
      expect(stmt.values).toEqual(VALUES);
    });

    it("PostgreSQL: a schema-qualified target still reads the stored row through its bare name", () => {
      const stmt = builderFor("postgres").buildUpsertQuery(
        '"shared"."orders"',
        COLUMNS("postgres"),
        VALUES,
        ['"slug"'],
        ['"hits"'],
        guardFor("postgres"),
        managedFor("postgres", { refresh: [], reset: [] }),
      );

      expect(stmt.sql).toBe(
        'INSERT INTO "shared"."orders" ("slug", "hits", "version", "created_at", "updated_at") ' +
          "VALUES (?, ?, ?, ?, ?) " +
          'ON CONFLICT ("slug") DO UPDATE SET "hits" = EXCLUDED."hits", ' +
          '"version" = COALESCE("orders"."version", 0) + 1 ' +
          'WHERE "orders"."tenant_id" = ?',
      );
      expect(stmt.values).toEqual([...VALUES, "acme"]);
    });

    it("SQLite: same shape with the lowercase excluded alias, guard once", () => {
      const stmt = builderFor("sqlite").buildUpsertQuery(
        '"orders"',
        COLUMNS("sqlite"),
        VALUES,
        ['"slug"'],
        ['"hits"'],
        guardFor("sqlite"),
        managedFor("sqlite"),
      );

      expect(stmt.sql).toBe(
        'INSERT INTO "orders" ("slug", "hits", "version", "created_at", "updated_at") ' +
          "VALUES (?, ?, ?, ?, ?) " +
          'ON CONFLICT ("slug") DO UPDATE SET "hits" = excluded."hits", ' +
          '"updated_at" = excluded."updated_at", ' +
          '"version" = COALESCE("orders"."version", 0) + 1, ' +
          '"deleted_at" = NULL ' +
          'WHERE "orders"."tenant_id" = ?',
      );
      expect(stmt.values).toEqual([...VALUES, "acme"]);
    });

    it("MySQL unguarded: VALUES() for proposed values, the stored row for the version", () => {
      const stmt = builderFor("mysql").buildUpsertQuery(
        "`orders`",
        COLUMNS("mysql"),
        VALUES,
        ["`slug`"],
        ["`hits`"],
        null,
        managedFor("mysql"),
      );

      expect(stmt.sql).toBe(
        "INSERT INTO `orders` (`slug`, `hits`, `version`, `created_at`, `updated_at`) " +
          "VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE " +
          "`hits` = VALUES(`hits`), " +
          "`updated_at` = VALUES(`updated_at`), " +
          "`version` = COALESCE(`orders`.`version`, 0) + 1, " +
          "`deleted_at` = NULL",
      );
      expect(stmt.values).toEqual(VALUES);
    });

    it("MySQL guarded: every managed assignment is wrapped in the tenant IF()", () => {
      const stmt = builderFor("mysql").buildUpsertQuery(
        "`orders`",
        COLUMNS("mysql"),
        VALUES,
        ["`slug`"],
        ["`hits`"],
        guardFor("mysql"),
        managedFor("mysql"),
      );

      expect(stmt.sql).toBe(
        "INSERT INTO `orders` (`slug`, `hits`, `version`, `created_at`, `updated_at`) " +
          "VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE " +
          "`hits` = IF(`orders`.`tenant_id` = ?, VALUES(`hits`), `orders`.`hits`), " +
          "`updated_at` = IF(`orders`.`tenant_id` = ?, VALUES(`updated_at`), `orders`.`updated_at`), " +
          "`version` = IF(`orders`.`tenant_id` = ?, COALESCE(`orders`.`version`, 0) + 1, `orders`.`version`), " +
          "`deleted_at` = IF(`orders`.`tenant_id` = ?, NULL, `orders`.`deleted_at`)",
      );
      expect(stmt.values).toEqual([...VALUES, "acme", "acme", "acme", "acme"]);
    });
  });

  describe("nothing of the caller's to update", () => {
    it("PostgreSQL/SQLite revive only a soft-deleted row, under the tenant guard", () => {
      for (const d of ["postgres", "sqlite"] as const) {
        const stmt = builderFor(d).buildUpsertQuery(
          '"orders"',
          ['"slug"', '"version"', '"tenant_id"'],
          ["a", 1, "acme"],
          ['"slug"'],
          [],
          guardFor(d),
          managedFor(d),
        );

        expect(stmt.sql).toBe(
          'INSERT INTO "orders" ("slug", "version", "tenant_id") VALUES (?, ?, ?) ' +
            'ON CONFLICT ("slug") DO UPDATE SET "deleted_at" = NULL ' +
            'WHERE "orders"."deleted_at" IS NOT NULL AND "orders"."tenant_id" = ?',
        );
        expect(stmt.values).toEqual(["a", 1, "acme", "acme"]);
      }
    });

    it("MySQL resets deleted_at through the tenant IF() — a live row is unchanged by it", () => {
      const stmt = builderFor("mysql").buildUpsertQuery(
        "`orders`",
        ["`slug`", "`version`", "`tenant_id`"],
        ["a", 1, "acme"],
        ["`slug`"],
        [],
        guardFor("mysql"),
        managedFor("mysql"),
      );

      expect(stmt.sql).toBe(
        "INSERT INTO `orders` (`slug`, `version`, `tenant_id`) VALUES (?, ?, ?) " +
          "ON DUPLICATE KEY UPDATE " +
          "`deleted_at` = IF(`orders`.`tenant_id` = ?, NULL, `orders`.`deleted_at`)",
      );
    });

    it("without a soft-delete column the version and timestamp alone never turn it into a write", () => {
      const managed = (d: Dialect) => managedFor(d, { reset: [] });

      const pg = builderFor("postgres").buildUpsertQuery(
        '"orders"',
        ['"slug"', '"version"'],
        ["a", 1],
        ['"slug"'],
        [],
        null,
        managed("postgres"),
      );
      expect(pg.sql).toBe(
        'INSERT INTO "orders" ("slug", "version") VALUES (?, ?) ' +
          'ON CONFLICT ("slug") DO NOTHING',
      );

      const my = builderFor("mysql").buildUpsertQuery(
        "`orders`",
        ["`slug`", "`version`"],
        ["a", 1],
        ["`slug`"],
        [],
        null,
        managed("mysql"),
      );
      expect(my.sql).toBe(
        "INSERT INTO `orders` (`slug`, `version`) VALUES (?, ?) " +
          "ON DUPLICATE KEY UPDATE `slug` = `slug`",
      );
    });
  });

  describe("batch", () => {
    it("PostgreSQL applies the same managed tail to a multi-row statement", () => {
      const stmt = builderFor("postgres").buildBatchUpsertQuery(
        '"orders"',
        ['"slug"', '"hits"', '"version"'],
        [sql`(${"a"}, ${1}, ${1})`, sql`(${"b"}, ${2}, ${1})`],
        ['"slug"'],
        ['"hits"'],
        null,
        managedFor("postgres", { refresh: [], reset: [] }),
      );

      expect(stmt.sql).toBe(
        'INSERT INTO "orders" ("slug", "hits", "version") VALUES (?, ?, ?), (?, ?, ?) ' +
          'ON CONFLICT ("slug") DO UPDATE SET "hits" = EXCLUDED."hits", ' +
          '"version" = COALESCE("orders"."version", 0) + 1',
      );
      expect(stmt.values).toEqual(["a", 1, 1, "b", 2, 1]);
    });

    it("MySQL guards the managed tail of a multi-row statement once per assignment", () => {
      const stmt = builderFor("mysql").buildBatchUpsertQuery(
        "`orders`",
        ["`slug`", "`hits`", "`version`"],
        [sql`(${"a"}, ${1}, ${1})`, sql`(${"b"}, ${2}, ${1})`],
        ["`slug`"],
        ["`hits`"],
        guardFor("mysql"),
        managedFor("mysql", { refresh: [], reset: [] }),
      );

      expect(stmt.sql).toBe(
        "INSERT INTO `orders` (`slug`, `hits`, `version`) VALUES (?, ?, ?), (?, ?, ?) " +
          "ON DUPLICATE KEY UPDATE " +
          "`hits` = IF(`orders`.`tenant_id` = ?, VALUES(`hits`), `orders`.`hits`), " +
          "`version` = IF(`orders`.`tenant_id` = ?, COALESCE(`orders`.`version`, 0) + 1, `orders`.`version`)",
      );
      expect(stmt.values).toEqual(["a", 1, 1, "b", 2, 1, "acme", "acme"]);
    });
  });
});
