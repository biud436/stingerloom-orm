/**
 * SqliteDriver.createTable() inline FOREIGN KEY embedding.
 *
 * SQLite cannot ALTER TABLE ADD FOREIGN KEY, so schema sync passes FK
 * definitions into createTable() and the driver must render them as part of
 * the CREATE TABLE statement (see supportsAlterAddForeignKey capability).
 */
import "reflect-metadata";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";
import type { CreateTableForeignKey } from "../../src/dialects/SqlDriver";

function makeDriver() {
  const queries: string[] = [];
  const connector = {
    query: async (sql: unknown) => {
      queries.push(
        typeof sql === "string" ? sql : ((sql as { text?: string; sql?: string }).text ?? (sql as { sql?: string }).sql ?? String(sql)),
      );
      return [];
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driver = new SqliteDriver(connector as any);
  return { driver, queries };
}

const COLUMNS = [
  { name: "id", options: { primary: true, type: "int" } },
  { name: "authorId", options: { type: "int", nullable: true } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any[];

describe("SqliteDriver.createTable inline FKs", () => {
  it("emits no FOREIGN KEY clause when no FK definitions are given", async () => {
    const { driver, queries } = makeDriver();
    await driver.createTable("posts", COLUMNS);
    expect(queries[0]).not.toContain("FOREIGN KEY");
  });

  it("embeds a FOREIGN KEY clause with wrapped identifiers", async () => {
    const { driver, queries } = makeDriver();
    const fks: CreateTableForeignKey[] = [
      {
        columnName: "authorId",
        referencedTable: "users",
        referencedColumn: "id",
      },
    ];
    await driver.createTable("posts", COLUMNS, fks);
    expect(queries[0]).toContain(
      'FOREIGN KEY ("authorId") REFERENCES "users" ("id")',
    );
  });

  it("includes the constraint name and referential actions", async () => {
    const { driver, queries } = makeDriver();
    const fks: CreateTableForeignKey[] = [
      {
        columnName: "authorId",
        referencedTable: "users",
        referencedColumn: "id",
        constraintName: "FK_posts_authorId",
        onDelete: "CASCADE",
        onUpdate: "RESTRICT",
      },
    ];
    await driver.createTable("posts", COLUMNS, fks);
    expect(queries[0]).toContain(
      'CONSTRAINT "FK_posts_authorId" FOREIGN KEY ("authorId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
  });

  it("supports multiple FK clauses in one statement", async () => {
    const { driver, queries } = makeDriver();
    const fks: CreateTableForeignKey[] = [
      { columnName: "authorId", referencedTable: "users", referencedColumn: "id" },
      { columnName: "blogId", referencedTable: "blogs", referencedColumn: "id" },
    ];
    await driver.createTable("posts", COLUMNS, fks);
    expect(queries[0]).toContain('FOREIGN KEY ("authorId") REFERENCES "users" ("id")');
    expect(queries[0]).toContain('FOREIGN KEY ("blogId") REFERENCES "blogs" ("id")');
  });

  it("drops referential actions that are not in the whitelist", async () => {
    const { driver, queries } = makeDriver();
    const fks: CreateTableForeignKey[] = [
      {
        columnName: "authorId",
        referencedTable: "users",
        referencedColumn: "id",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onDelete: "CASCADE; DROP TABLE users" as any,
      },
    ];
    await driver.createTable("posts", COLUMNS, fks);
    expect(queries[0]).toContain('FOREIGN KEY ("authorId") REFERENCES "users" ("id")');
    expect(queries[0]).not.toContain("ON DELETE");
    expect(queries[0]).not.toContain("DROP TABLE");
  });

  it("still throws from addForeignKey (ALTER is unsupported on SQLite)", () => {
    const { driver } = makeDriver();
    expect(() =>
      driver.addForeignKey("posts", "authorId", "users", "id"),
    ).toThrow(/does not support ALTER TABLE ADD FOREIGN KEY/);
  });
});
