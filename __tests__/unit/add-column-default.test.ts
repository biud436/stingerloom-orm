/**
 * A column added to an existing table carries its declared
 * `@Column({ default })`, rendered the way CREATE TABLE renders it.
 *
 * ADD COLUMN used a type placeholder (`DEFAULT ''`, `DEFAULT 0`) on the
 * runtime sync path and no DEFAULT at all from `migrate:generate`, so the
 * same entity got a different column default depending on whether its table
 * already existed. Both paths also appended the decorator's `int` / `boolean`
 * length to the type, which PostgreSQL rejects (`INTEGER(11)`).
 */
import {
  addColumnDefaultClause,
  isExpressionDefault,
  renderDefaultClause,
} from "../../src/dialects/columnDefault";
import { createSchemaDiffResult, withDeclaredSize } from "../../src/core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";

describe("renderDefaultClause / addColumnDefaultClause", () => {
  it("renders literals, expressions and booleans as CREATE TABLE does", () => {
    expect(renderDefaultClause(undefined)).toBe("");
    expect(renderDefaultClause(null)).toBe(" DEFAULT NULL");
    expect(renderDefaultClause(5)).toBe(" DEFAULT 5");
    expect(renderDefaultClause("it's")).toBe(" DEFAULT 'it''s'");
    expect(renderDefaultClause("(CURRENT_TIMESTAMP)")).toBe(" DEFAULT (CURRENT_TIMESTAMP)");
    expect(renderDefaultClause(true)).toBe(" DEFAULT TRUE");
  });

  it("spells booleans per dialect for ADD COLUMN", () => {
    expect(addColumnDefaultClause(true, "mysql")).toBe(" DEFAULT 1");
    expect(addColumnDefaultClause(false, "postgres")).toBe(" DEFAULT FALSE");
    expect(addColumnDefaultClause(true, "sqlite")).toBe(" DEFAULT TRUE");
  });

  it("adds nothing for a missing or null default", () => {
    expect(addColumnDefaultClause(undefined, "postgres")).toBe("");
    expect(addColumnDefaultClause(null, "mysql")).toBe("");
  });

  it("leaves an expression default out on SQLite only", () => {
    expect(isExpressionDefault("(CURRENT_TIMESTAMP)")).toBe(true);
    expect(isExpressionDefault("active")).toBe(false);
    expect(addColumnDefaultClause("(CURRENT_TIMESTAMP)", "sqlite")).toBe("");
    expect(addColumnDefaultClause("(CURRENT_TIMESTAMP)", "postgres")).toBe(
      " DEFAULT (CURRENT_TIMESTAMP)",
    );
  });
});

describe("migrate:generate ADD COLUMN with a declared default", () => {
  const diff = createSchemaDiffResult({
    addColumns: [
      {
        tableName: "users",
        columnName: "status",
        columnType: "VARCHAR(20)",
        nullable: false,
        defaultValue: "active",
      },
      {
        tableName: "users",
        columnName: "enabled",
        columnType: "BOOLEAN",
        nullable: false,
        defaultValue: true,
      },
      { tableName: "users", columnName: "nickname", columnType: "VARCHAR(30)", nullable: true },
    ],
  });

  it("appends the default on PostgreSQL", async () => {
    const { up } = await new SchemaDiffMigrationGenerator().dryRun(diff, "postgres");

    expect(up).toContainEqual(
      'ALTER TABLE "users" ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT \'active\'',
    );
    expect(up).toContainEqual('ALTER TABLE "users" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT TRUE');
    expect(up).toContainEqual('ALTER TABLE "users" ADD COLUMN "nickname" VARCHAR(30) NULL');
  });

  it("spells a boolean default 1/0 on MySQL", async () => {
    const { up } = await new SchemaDiffMigrationGenerator().dryRun(diff, "mysql");

    expect(up).toContainEqual("ALTER TABLE `users` ADD COLUMN `enabled` BOOLEAN NOT NULL DEFAULT 1");
  });
});

describe("withDeclaredSize", () => {
  it("puts a declared length only on a character type", () => {
    expect(withDeclaredSize("VARCHAR", { expectedLength: 30 })).toBe("VARCHAR(30)");
    expect(withDeclaredSize("INTEGER", { expectedLength: 11 })).toBe("INTEGER");
    expect(withDeclaredSize("BOOLEAN", { expectedLength: 1 })).toBe("BOOLEAN");
    expect(withDeclaredSize("VARCHAR(20)", { expectedLength: 30 })).toBe("VARCHAR(20)");
  });

  it("puts a declared precision and scale on a type without arguments", () => {
    expect(withDeclaredSize("DECIMAL", { expectedPrecision: 10, expectedScale: 2 })).toBe("DECIMAL(10,2)");
    expect(withDeclaredSize("NUMERIC", { expectedPrecision: 8 })).toBe("NUMERIC(8)");
  });

  it("keeps a PostgreSQL int column's ADD COLUMN valid in migrate:generate", async () => {
    const diff = createSchemaDiffResult({
      addColumns: [
        { tableName: "users", columnName: "visits", columnType: "INTEGER", nullable: false, expectedLength: 11 },
      ],
    });

    const { up } = await new SchemaDiffMigrationGenerator().dryRun(diff, "postgres");

    expect(up).toContainEqual('ALTER TABLE "users" ADD COLUMN "visits" INTEGER NOT NULL');
  });
});
