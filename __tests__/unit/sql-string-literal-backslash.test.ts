/**
 * A backslash in a hand-built SQL string literal.
 *
 * MySQL / MariaDB read a backslash inside `'...'` as an escape character, so
 * a column default such as `C:\` closed over its own quote and the rest of
 * the DDL became part of the literal, and `a\nb` was stored as a line break.
 * The same held for a migration or seeder name written into the tracking
 * table. Generated migration files dropped a backslash as well, because the
 * SQL sits in a JavaScript template literal.
 */
import { sqlStringLiteral } from "../../src/utils/escapeSqlLiteral";
import { addColumnDefaultClause, renderDefaultValue } from "../../src/dialects/columnDefault";
import { MySqlColumnDefinitionBuilder } from "../../src/dialects/mysql/MySqlColumnDefinitionBuilder";
import { PostgresColumnDefinitionBuilder } from "../../src/dialects/postgres/PostgresColumnDefinitionBuilder";
import { SqliteColumnDefinitionBuilder } from "../../src/dialects/sqlite/SqliteColumnDefinitionBuilder";
import {
  Migration,
  MigrationContext,
  MigrationQueryRunner,
  MySqlMigrationRunner,
  PostgresMigrationRunner,
  SqliteMigrationRunner,
} from "../../src/migration";
import { ISqlDriver } from "../../src/dialects/SqlDriver";
import { createSchemaDiffResult } from "../../src/core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";
import { OrmError } from "../../src/errors/OrmError";

const BACKSLASH = "\\";

describe("sqlStringLiteral", () => {
  it("doubles a backslash on MySQL", () => {
    expect(sqlStringLiteral(`C:${BACKSLASH}`, "mysql")).toBe(`'C:${BACKSLASH}${BACKSLASH}'`);
    expect(sqlStringLiteral(`a${BACKSLASH}'; DROP TABLE t; -- `, "mysql")).toBe(
      `'a${BACKSLASH}${BACKSLASH}''; DROP TABLE t; -- '`,
    );
  });

  it("writes an escape string on PostgreSQL only when a backslash is present", () => {
    expect(sqlStringLiteral(`C:${BACKSLASH}`, "postgres")).toBe(`E'C:${BACKSLASH}${BACKSLASH}'`);
    expect(sqlStringLiteral("it's", "postgres")).toBe("'it''s'");
  });

  it("keeps a backslash as written on SQLite", () => {
    expect(sqlStringLiteral(`C:${BACKSLASH}`, "sqlite")).toBe(`'C:${BACKSLASH}'`);
    expect(sqlStringLiteral("it's", "sqlite")).toBe("'it''s'");
  });

  it("rejects a null byte on every dialect", () => {
    for (const dialect of ["mysql", "postgres", "sqlite"] as const) {
      expect(() => sqlStringLiteral("a\0b", dialect)).toThrow(OrmError);
    }
  });
});

describe("column default with a backslash", () => {
  const option = { type: "varchar", length: 50, nullable: true, default: `C:${BACKSLASH}` } as any;
  const ctx = { columnName: "c" } as any;

  it("is escaped per dialect in CREATE TABLE", () => {
    expect(new MySqlColumnDefinitionBuilder().buildColumnDef(option, ctx)).toContain(
      `DEFAULT 'C:${BACKSLASH}${BACKSLASH}'`,
    );
    expect(new PostgresColumnDefinitionBuilder().buildColumnDef(option, ctx)).toContain(
      `DEFAULT E'C:${BACKSLASH}${BACKSLASH}'`,
    );
    expect(new SqliteColumnDefinitionBuilder().buildColumnDef(option, ctx)).toContain(
      `DEFAULT 'C:${BACKSLASH}'`,
    );
  });

  it("is escaped per dialect in ADD COLUMN", () => {
    expect(addColumnDefaultClause(`C:${BACKSLASH}`, "mysql")).toBe(
      ` DEFAULT 'C:${BACKSLASH}${BACKSLASH}'`,
    );
    expect(addColumnDefaultClause(`C:${BACKSLASH}`, "postgres")).toBe(
      ` DEFAULT E'C:${BACKSLASH}${BACKSLASH}'`,
    );
    expect(addColumnDefaultClause(`C:${BACKSLASH}`, "sqlite")).toBe(` DEFAULT 'C:${BACKSLASH}'`);
  });

  it("stays literal where the value is written into a SQLite VALUES row", () => {
    expect(renderDefaultValue(`C:${BACKSLASH}`)).toBe(`'C:${BACKSLASH}'`);
  });
});

describe("migration tracking row with a backslash in the name", () => {
  function setup() {
    const queries: string[] = [];
    const queryRunner: MigrationQueryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        return { results: [] };
      }),
    } as any;
    const driver = {
      isMySqlFamily: jest.fn().mockReturnValue(false),
      acquireAdvisoryLock: jest.fn().mockResolvedValue(true),
      releaseAdvisoryLock: jest.fn().mockResolvedValue(undefined),
    } as unknown as ISqlDriver;
    class Odd extends Migration {
      get name() {
        return `2026${BACKSLASH}odd`;
      }
      async up(_context: MigrationContext) {}
      async down(_context: MigrationContext) {}
    }
    return { queries, queryRunner, driver, migrations: [new Odd()] };
  }

  it.each([
    ["mysql", MySqlMigrationRunner, `'2026${BACKSLASH}${BACKSLASH}odd'`],
    ["postgres", PostgresMigrationRunner, `E'2026${BACKSLASH}${BACKSLASH}odd'`],
    ["sqlite", SqliteMigrationRunner, `'2026${BACKSLASH}odd'`],
  ] as const)("records the name as a %s literal", async (_dialect, Runner, literal) => {
    const { queries, queryRunner, driver, migrations } = setup();
    await new Runner(migrations, driver, queryRunner).runAll();
    const insert = queries.find((q) => q.startsWith("INSERT INTO"));
    expect(insert).toContain(`VALUES (${literal})`);
  });
});

describe("generated migration file", () => {
  it("keeps a backslash in the SQL through the template literal", () => {
    const diff = createSchemaDiffResult({
      addColumns: [
        {
          tableName: "t",
          columnName: "path",
          columnType: "VARCHAR(50)",
          nullable: true,
          defaultValue: `C:${BACKSLASH}`,
        },
      ],
    });
    const code = new SchemaDiffMigrationGenerator().generate(diff, "mysql");
    const statement = /await query\(`((?:\\.|[^`\\])*ADD COLUMN(?:\\.|[^`\\])*)`\);/.exec(code);
    expect(statement).not.toBeNull();
    // Evaluating the emitted template literal yields the SQL MySQL must see.
    const sql = new Function(`return \`${statement![1]}\`;`)() as string;
    expect(sql).toContain(`DEFAULT 'C:${BACKSLASH}${BACKSLASH}'`);
  });
});
