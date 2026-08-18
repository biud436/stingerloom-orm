/**
 * `ISqlDriver.escapeIdentifier()` — the identifier-quoting entry point a
 * hand-written migration uses.
 *
 * `MigrationContext.driver` is typed as `ISqlDriver`, and every documented
 * migration example calls `driver.escapeIdentifier(...)` — but the interface
 * declared no such method and the concrete drivers only had the internal
 * `wrap()`, so a copied example failed to compile in TypeScript and died with
 * "driver.escapeIdentifier is not a function" in JavaScript.
 */
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";
import { ISqlDriver } from "../../src/dialects/SqlDriver";

const stubConnector: any = { query: jest.fn() };

describe("ISqlDriver.escapeIdentifier", () => {
  const drivers: Array<[string, ISqlDriver, string]> = [
    ["MySQL", new MySqlDriver(stubConnector, "mysql" as any), "`user`"],
    [
      "PostgreSQL",
      new PostgresDriver(stubConnector, "postgres" as any, "public"),
      '"user"',
    ],
    ["SQLite", new SqliteDriver(stubConnector), '"user"'],
  ];

  it.each(drivers)("%s quotes a reserved word", (_name, driver, expected) => {
    expect(driver.escapeIdentifier("user")).toBe(expected);
  });

  it("doubles an embedded quote character (MySQL)", () => {
    const driver = new MySqlDriver(stubConnector, "mysql" as any);
    expect(driver.escapeIdentifier("we`ird")).toBe("`we``ird`");
  });

  it("doubles an embedded quote character (PostgreSQL, SQLite)", () => {
    expect(
      new PostgresDriver(stubConnector, "postgres" as any, "public").escapeIdentifier(
        'we"ird',
      ),
    ).toBe('"we""ird"');
    expect(new SqliteDriver(stubConnector).escapeIdentifier('we"ird')).toBe(
      '"we""ird"',
    );
  });

  it("matches the internal wrap() on every driver", () => {
    for (const [, driver] of drivers) {
      expect(driver.escapeIdentifier("created_at")).toBe(
        (driver as any).wrap("created_at"),
      );
    }
  });

  it("does not qualify with the PostgreSQL schema (wrapQualified does)", () => {
    const driver = new PostgresDriver(stubConnector, "postgres" as any, "tenant_a");

    expect(driver.escapeIdentifier("users")).toBe('"users"');
    expect(driver.wrapQualified("users")).toBe('"tenant_a"."users"');
  });
});
