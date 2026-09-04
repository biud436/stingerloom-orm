/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";
import { SchemaDiffResult } from "../../src/core/generators/SchemaDiff";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

// ─────────────────────────────────────────────────
// Test entities
// ─────────────────────────────────────────────────

@Entity()
class SqliteDiffUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "boolean" })
  active!: boolean;
}

@Entity()
class SqliteDiffPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "text", nullable: true })
  body!: string;

  @Column({ type: "float" })
  score!: number;

  @Column({ type: "blob", nullable: true })
  data!: Buffer;
}

// ─────────────────────────────────────────────────
// Mock query runner
// ─────────────────────────────────────────────────

function createMockQueryRunner(responseMap: Record<string, any[]>): {
  query: jest.Mock;
} {
  const mockQuery = jest.fn((sqlInput: string) => {
    for (const [key, value] of Object.entries(responseMap)) {
      if (sqlInput.includes(key)) {
        return Promise.resolve(value);
      }
    }
    return Promise.resolve([]);
  });
  return { query: mockQuery };
}

// ─────────────────────────────────────────────────
// SchemaDiff SQLite tests
// ─────────────────────────────────────────────────

describe("SchemaDiff — SQLite dialect", () => {
  let schemaDiff: SchemaDiff;

  beforeEach(() => {
    schemaDiff = new SchemaDiff();
  });

  describe("getDbColumns — PRAGMA query", () => {
    it("should use PRAGMA table_xinfo for SQLite", async () => {
      const runner = createMockQueryRunner({});
      await schemaDiff.diff([SqliteDiffUser], runner, "sqlite");

      expect(runner.query).toHaveBeenCalled();
      const calls = runner.query.mock.calls;
      const pragmaCall = calls.find((call: any[]) =>
        typeof call[0] === "string" && call[0].includes("PRAGMA table_xinfo"),
      );
      expect(pragmaCall).toBeDefined();
    });

    it("should NOT use information_schema for SQLite", async () => {
      const runner = createMockQueryRunner({});
      await schemaDiff.diff([SqliteDiffUser], runner, "sqlite");

      const calls = runner.query.mock.calls;
      const infoSchemaCall = calls.find((call: any[]) => {
        const sqlText =
          typeof call[0] === "string"
            ? call[0]
            : call[0]?.text ?? call[0]?.sql ?? "";
        return sqlText.includes("information_schema");
      });
      expect(infoSchemaCall).toBeUndefined();
    });

    it("should detect new table when PRAGMA returns empty", async () => {
      const runner = createMockQueryRunner({});
      const result = await schemaDiff.diff(
        [SqliteDiffUser],
        runner,
        "sqlite",
      );

      expect(result.addTables).toContain("sqlite_diff_user");
    });
  });

  describe("PRAGMA result normalization", () => {
    it("should convert PRAGMA table_xinfo rows to DbColumnInfo format", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_user: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "age", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 3, name: "active", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffUser],
        runner,
        "sqlite",
      );

      // All columns match — no changes expected
      expect(result.addTables).toHaveLength(0);
      expect(result.addColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(0);
      expect(result.alterColumns).toHaveLength(0);
    });

    it("should handle notnull=0 as nullable YES", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_post: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "body", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
          { cid: 3, name: "score", type: "REAL", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 4, name: "data", type: "BLOB", notnull: 0, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffPost],
        runner,
        "sqlite",
      );

      expect(result.addTables).toHaveLength(0);
      expect(result.addColumns).toHaveLength(0);
      expect(result.alterColumns).toHaveLength(0);
    });

    it("should default to TEXT when PRAGMA type is empty", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_user: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "name", type: "", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "age", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 3, name: "active", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffUser],
        runner,
        "sqlite",
      );

      expect(result.alterColumns).toHaveLength(0);
    });
  });

  describe("castTypeSqlite mapping", () => {
    it("should map varchar to TEXT", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_user: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffUser],
        runner,
        "sqlite",
      );

      const nameCol = result.addColumns.find((c) => c.columnName === "name");
      expect(nameCol).toBeDefined();
      expect(nameCol!.columnType).toBe("TEXT");
    });

    it("should map int/number to INTEGER", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_user: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "active", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffUser],
        runner,
        "sqlite",
      );

      const ageCol = result.addColumns.find((c) => c.columnName === "age");
      expect(ageCol).toBeDefined();
      expect(ageCol!.columnType).toBe("INTEGER");
    });

    it("should map boolean to INTEGER", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_user: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "age", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffUser],
        runner,
        "sqlite",
      );

      const activeCol = result.addColumns.find((c) => c.columnName === "active");
      expect(activeCol).toBeDefined();
      expect(activeCol!.columnType).toBe("INTEGER");
    });

    it("should map float to REAL", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_post: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "body", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
          { cid: 3, name: "data", type: "BLOB", notnull: 0, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffPost],
        runner,
        "sqlite",
      );

      const scoreCol = result.addColumns.find((c) => c.columnName === "score");
      expect(scoreCol).toBeDefined();
      expect(scoreCol!.columnType).toBe("REAL");
    });

    it("should map blob to BLOB", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_post: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "body", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
          { cid: 3, name: "score", type: "REAL", notnull: 1, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffPost],
        runner,
        "sqlite",
      );

      const dataCol = result.addColumns.find((c) => c.columnName === "data");
      expect(dataCol).toBeDefined();
      expect(dataCol!.columnType).toBe("BLOB");
    });
  });

  describe("typesMatch — SQLite type affinity aliases", () => {
    it("should match TEXT and VARCHAR as equivalent", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_user: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "name", type: "VARCHAR", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "age", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 3, name: "active", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffUser],
        runner,
        "sqlite",
      );

      expect(result.alterColumns).toHaveLength(0);
    });

    it("should match INTEGER and INT as equivalent", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_user: [
          { cid: 0, name: "id", type: "INT", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "age", type: "INT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 3, name: "active", type: "INT", notnull: 1, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffUser],
        runner,
        "sqlite",
      );

      expect(result.alterColumns).toHaveLength(0);
    });

    it("should match REAL and FLOAT as equivalent", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_post: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "body", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
          { cid: 3, name: "score", type: "FLOAT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 4, name: "data", type: "BLOB", notnull: 0, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffPost],
        runner,
        "sqlite",
      );

      expect(result.alterColumns).toHaveLength(0);
    });
  });

  describe("add/drop column detection", () => {
    it("should detect added columns in SQLite", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_user: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffUser],
        runner,
        "sqlite",
      );

      expect(result.addColumns).toHaveLength(2);
      const addedNames = result.addColumns.map((c) => c.columnName);
      expect(addedNames).toContain("age");
      expect(addedNames).toContain("active");
    });

    it("should detect dropped columns in SQLite", async () => {
      const runner = createMockQueryRunner({
        sqlite_diff_user: [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
          { cid: 1, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 2, name: "age", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 3, name: "active", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
          { cid: 4, name: "legacy_col", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        ],
      });

      const result = await schemaDiff.diff(
        [SqliteDiffUser],
        runner,
        "sqlite",
      );

      expect(result.dropColumns).toHaveLength(1);
      expect(result.dropColumns[0].columnName).toBe("legacy_col");
    });
  });
});

// ─────────────────────────────────────────────────
// SchemaDiffMigrationGenerator — SQLite dialect
// ─────────────────────────────────────────────────

describe("SchemaDiffMigrationGenerator — SQLite dialect", () => {
  let generator: SchemaDiffMigrationGenerator;

  beforeEach(() => {
    generator = new SchemaDiffMigrationGenerator();
  });

  it("should use double quotes for SQLite identifiers", () => {
    const diff: SchemaDiffResult = {
      addTables: [],
      dropTables: [],
      addColumns: [
        {
          tableName: "users",
          columnName: "email",
          columnType: "TEXT",
          nullable: false,
        },
      ],
      dropColumns: [],
      alterColumns: [],
    };

    const content = generator.generate(diff, "sqlite");

    expect(content).toContain('"users"');
    expect(content).toContain('"email"');
    // Ensure no MySQL-style backtick identifier quoting (template literal backticks are OK)
    expect(content).not.toMatch(/`users`/);
    expect(content).not.toMatch(/`email`/);
  });

  it("should throw an explicit error for ALTER COLUMN TYPE (unsupported in SQLite)", () => {
    const diff: SchemaDiffResult = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [
        {
          tableName: "users",
          columnName: "name",
          columnType: "INTEGER",
          currentType: "TEXT",
        },
      ],
    };

    // Previously this emitted a `// TODO: ...` no-op migration; now it must
    // fail at generation time with manual-migration guidance.
    expect(() => generator.generate(diff, "sqlite")).toThrow(OrmError);
    try {
      generator.generate(diff, "sqlite");
    } catch (e: any) {
      expect(e.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
      expect(e.message).toContain('"users"."name"');
      expect(e.message).toContain("TEXT -> INTEGER");
      expect(e.suggestion).toContain("recreates the table");
    }
  });

  it("should generate ADD COLUMN statements for SQLite", () => {
    const diff: SchemaDiffResult = {
      addTables: [],
      dropTables: [],
      addColumns: [
        {
          tableName: "posts",
          columnName: "score",
          columnType: "REAL",
          nullable: true,
        },
      ],
      dropColumns: [],
      alterColumns: [],
    };

    const content = generator.generate(diff, "sqlite");

    expect(content).toContain("ADD COLUMN");
    expect(content).toContain('"posts"');
    expect(content).toContain('"score"');
    expect(content).toContain("REAL");
    expect(content).toContain("NULL");
  });

  it("should generate DROP TABLE in down() for new tables", () => {
    const diff: SchemaDiffResult = {
      addTables: ["sqlite_diff_user"],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
      addTableEntityMap: { sqlite_diff_user: SqliteDiffUser },
    };

    const content = generator.generate(diff, "sqlite");

    expect(content).toContain("CREATE TABLE");
    expect(content).toContain("DROP TABLE IF EXISTS");
    expect(content).toContain('"sqlite_diff_user"');
  });

  it("should throw for new tables without an entity class", () => {
    const diff: SchemaDiffResult = {
      addTables: ["new_table"],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
    };

    expect(() => generator.generate(diff, "sqlite")).toThrow(OrmError);
    try {
      generator.generate(diff, "sqlite");
    } catch (e: any) {
      expect(e.code).toBe(OrmErrorCode.SCHEMA_ERROR);
      expect(e.message).toContain("new_table");
    }
  });
});

// ─────────────────────────────────────────────────
// SqliteDriver — unsupported DDL methods
// ─────────────────────────────────────────────────

describe("SqliteDriver — unsupported DDL operations", () => {
  let driver: SqliteDriver;

  beforeEach(() => {
    const mockConnector = {
      query: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
    } as any;
    driver = new SqliteDriver(mockConnector);
  });

  it("addPrimaryKey should throw OrmError with UNSUPPORTED_OPERATION", () => {
    expect(() => driver.addPrimaryKey("users", "id")).toThrow(OrmError);
    try {
      driver.addPrimaryKey("users", "id");
    } catch (e: any) {
      expect(e.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
      expect(e.message).toContain("ADD PRIMARY KEY");
      expect(e.message).toContain("Recreate the table");
    }
  });

  it("dropPrimaryKey should throw OrmError with UNSUPPORTED_OPERATION", () => {
    expect(() => driver.dropPrimaryKey("users")).toThrow(OrmError);
    try {
      driver.dropPrimaryKey("users");
    } catch (e: any) {
      expect(e.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
      expect(e.message).toContain("DROP PRIMARY KEY");
    }
  });

  it("addForeignKey should throw OrmError with UNSUPPORTED_OPERATION", () => {
    expect(() =>
      driver.addForeignKey("posts", "user_id", "users", "id"),
    ).toThrow(OrmError);
    try {
      driver.addForeignKey("posts", "user_id", "users", "id");
    } catch (e: any) {
      expect(e.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
      expect(e.message).toContain("ADD FOREIGN KEY");
    }
  });

  it("dropForeignKey should throw OrmError with UNSUPPORTED_OPERATION", () => {
    expect(() => driver.dropForeignKey("posts", "user_id")).toThrow(OrmError);
    try {
      driver.dropForeignKey("posts", "user_id");
    } catch (e: any) {
      expect(e.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
      expect(e.message).toContain("DROP FOREIGN KEY");
    }
  });

  it("addAutoIncrement should throw OrmError with UNSUPPORTED_OPERATION", () => {
    expect(() => driver.addAutoIncrement("users", "id")).toThrow(OrmError);
    try {
      driver.addAutoIncrement("users", "id");
    } catch (e: any) {
      expect(e.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
      expect(e.message).toContain("AUTOINCREMENT");
    }
  });
});

// ─────────────────────────────────────────────────
// OrmErrorCode — UNSUPPORTED_OPERATION exists
// ─────────────────────────────────────────────────

describe("OrmErrorCode", () => {
  it("should have UNSUPPORTED_OPERATION code", () => {
    expect(OrmErrorCode.UNSUPPORTED_OPERATION).toBe("ORM_UNSUPPORTED_OPERATION");
  });
});
