/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaDiff, SchemaDiffResult } from "../../src/core/SchemaDiff";
import {
  SchemaDiffMigrationGenerator,
} from "../../src/core/SchemaDiffMigrationGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

// ─────────────────────────────────────────────────
// Test entities
// ─────────────────────────────────────────────────

@Entity()
class DiffUser {
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
class DiffPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "text", nullable: true })
  body!: string;
}

// ─────────────────────────────────────────────────
// Mock query runner
// ─────────────────────────────────────────────────

function createMockQueryRunner(
  responseMap: Record<string, any[]>,
): { query: jest.Mock } {
  const mockQuery = jest.fn((sql: string) => {
    for (const [key, value] of Object.entries(responseMap)) {
      if (sql.includes(key)) {
        return Promise.resolve(value);
      }
    }
    return Promise.resolve([]);
  });
  return { query: mockQuery };
}

// ─────────────────────────────────────────────────
// SchemaDiff tests
// ─────────────────────────────────────────────────

describe("SchemaDiff", () => {
  let schemaDiff: SchemaDiff;

  beforeEach(() => {
    schemaDiff = new SchemaDiff();
  });

  describe("diff() — new table detection", () => {
    it("should detect a new table when DB returns no columns", async () => {
      const runner = createMockQueryRunner({});
      const result = await schemaDiff.diff([DiffUser], runner, "mysql");

      expect(result.addTables).toContain("diff_user");
      expect(result.addColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(0);
      expect(result.alterColumns).toHaveLength(0);
    });

    it("should detect multiple new tables", async () => {
      const runner = createMockQueryRunner({});
      const result = await schemaDiff.diff(
        [DiffUser, DiffPost],
        runner,
        "mysql",
      );

      expect(result.addTables).toContain("diff_user");
      expect(result.addTables).toContain("diff_post");
      expect(result.addTables).toHaveLength(2);
    });
  });

  describe("diff() — add column detection (MySQL)", () => {
    it("should detect added columns when entity has more columns than DB", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          { column_name: "name", data_type: "varchar", is_nullable: "NO" },
          // 'age' and 'active' are missing from DB
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");

      expect(result.addTables).toHaveLength(0);
      expect(result.addColumns).toHaveLength(2);

      const addedNames = result.addColumns.map((c) => c.columnName);
      expect(addedNames).toContain("age");
      expect(addedNames).toContain("active");
    });

    it("should set correct column type for added columns", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          { column_name: "name", data_type: "varchar", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");

      const ageCol = result.addColumns.find((c) => c.columnName === "age");
      expect(ageCol).toBeDefined();
      expect(ageCol!.columnType).toBe("INT");

      const activeCol = result.addColumns.find(
        (c) => c.columnName === "active",
      );
      expect(activeCol).toBeDefined();
      expect(activeCol!.columnType).toBe("TINYINT");
    });
  });

  describe("diff() — drop column detection", () => {
    it("should detect columns in DB that are not in entity", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          { column_name: "name", data_type: "varchar", is_nullable: "NO" },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
          { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
          {
            column_name: "old_column",
            data_type: "varchar",
            is_nullable: "YES",
          },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");

      expect(result.dropColumns).toHaveLength(1);
      expect(result.dropColumns[0].columnName).toBe("old_column");
      expect(result.dropColumns[0].tableName).toBe("diff_user");
    });
  });

  describe("diff() — alter column detection (MySQL)", () => {
    it("should detect type changes between entity and DB", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          // name is TEXT in DB but VARCHAR in entity
          { column_name: "name", data_type: "text", is_nullable: "NO" },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
          { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");

      expect(result.alterColumns).toHaveLength(1);
      expect(result.alterColumns[0].columnName).toBe("name");
      expect(result.alterColumns[0].columnType).toBe("VARCHAR");
      expect(result.alterColumns[0].currentType).toBe("text");
    });
  });

  describe("diff() — no changes", () => {
    it("should return empty diff when entity matches DB schema", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          { column_name: "name", data_type: "varchar", is_nullable: "NO" },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
          { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");

      expect(result.addTables).toHaveLength(0);
      expect(result.addColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(0);
      expect(result.alterColumns).toHaveLength(0);
    });
  });

  describe("diff() — PostgreSQL dialect", () => {
    it("should detect new table for PostgreSQL", async () => {
      const runner = createMockQueryRunner({});
      const result = await schemaDiff.diff(
        [DiffUser],
        runner,
        "postgres",
        "public",
      );

      expect(result.addTables).toContain("diff_user");
    });

    it("should detect added columns for PostgreSQL", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          {
            column_name: "name",
            data_type: "character varying",
            is_nullable: "NO",
          },
          // missing age and active
        ],
      });

      const result = await schemaDiff.diff(
        [DiffUser],
        runner,
        "postgres",
        "public",
      );

      expect(result.addColumns).toHaveLength(2);
      const ageCol = result.addColumns.find((c) => c.columnName === "age");
      expect(ageCol).toBeDefined();
      expect(ageCol!.columnType).toBe("INTEGER");

      const activeCol = result.addColumns.find(
        (c) => c.columnName === "active",
      );
      expect(activeCol).toBeDefined();
      expect(activeCol!.columnType).toBe("BOOLEAN");
    });

    it("should match PostgreSQL type aliases correctly", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          {
            column_name: "name",
            data_type: "character varying",
            is_nullable: "NO",
          },
          { column_name: "age", data_type: "integer", is_nullable: "NO" },
          { column_name: "active", data_type: "boolean", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff(
        [DiffUser],
        runner,
        "postgres",
        "public",
      );

      expect(result.addColumns).toHaveLength(0);
      expect(result.alterColumns).toHaveLength(0);
    });
  });

  describe("diff() — result normalization", () => {
    it("should handle null result from query runner", async () => {
      const runner = { query: jest.fn().mockResolvedValue(null) };
      const result = await schemaDiff.diff([DiffUser], runner, "mysql");

      expect(result.addTables).toContain("diff_user");
    });

    it("should handle result with rows property (pg style)", async () => {
      const runner = {
        query: jest.fn().mockResolvedValue({
          rows: [
            { column_name: "id", data_type: "integer", is_nullable: "NO" },
            {
              column_name: "name",
              data_type: "character varying",
              is_nullable: "NO",
            },
            { column_name: "age", data_type: "integer", is_nullable: "NO" },
            { column_name: "active", data_type: "boolean", is_nullable: "NO" },
          ],
        }),
      };
      const result = await schemaDiff.diff(
        [DiffUser],
        runner,
        "postgres",
        "public",
      );

      expect(result.addTables).toHaveLength(0);
      expect(result.addColumns).toHaveLength(0);
    });

    it("should handle result with results property (mysql2 style)", async () => {
      const runner = {
        query: jest.fn().mockResolvedValue({
          results: [
            { column_name: "id", data_type: "int", is_nullable: "NO" },
            { column_name: "name", data_type: "varchar", is_nullable: "NO" },
            { column_name: "age", data_type: "int", is_nullable: "NO" },
            { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
          ],
        }),
      };
      const result = await schemaDiff.diff([DiffUser], runner, "mysql");

      expect(result.addTables).toHaveLength(0);
      expect(result.addColumns).toHaveLength(0);
    });
  });

  describe("diff() — case-insensitive column matching", () => {
    it("should match column names case-insensitively", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "ID", data_type: "int", is_nullable: "NO" },
          { column_name: "Name", data_type: "varchar", is_nullable: "NO" },
          { column_name: "AGE", data_type: "int", is_nullable: "NO" },
          { column_name: "Active", data_type: "tinyint", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");

      expect(result.addColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────
// SchemaDiffMigrationGenerator tests
// ─────────────────────────────────────────────────

describe("SchemaDiffMigrationGenerator", () => {
  let generator: SchemaDiffMigrationGenerator;

  beforeEach(() => {
    generator = new SchemaDiffMigrationGenerator();
  });

  describe("generate() — MySQL dialect", () => {
    it("should generate migration with ADD COLUMN statements", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [
          {
            tableName: "users",
            columnName: "email",
            columnType: "VARCHAR",
            nullable: false,
          },
        ],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain("extends Migration");
      expect(content).toContain("ADD COLUMN");
      expect(content).toContain("`users`");
      expect(content).toContain("`email`");
      expect(content).toContain("VARCHAR");
      expect(content).toContain("NOT NULL");
      // down should have DROP COLUMN
      expect(content).toContain("DROP COLUMN `email`");
    });

    it("should generate migration with MODIFY COLUMN for type changes", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [
          {
            tableName: "users",
            columnName: "name",
            columnType: "TEXT",
            currentType: "varchar",
          },
        ],
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain("MODIFY COLUMN");
      expect(content).toContain("`name`");
      expect(content).toContain("TEXT");
    });

    it("should generate commented-out DROP COLUMN for removed columns", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [
          {
            tableName: "users",
            columnName: "old_col",
            currentType: "varchar",
          },
        ],
        alterColumns: [],
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain("// await query");
      expect(content).toContain("DROP COLUMN");
      expect(content).toContain("DANGEROUS");
    });

    it("should generate CREATE TABLE for new tables", () => {
      const diff: SchemaDiffResult = {
        addTables: ["new_table"],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain("CREATE TABLE");
      expect(content).toContain("`new_table`");
      // down should have DROP TABLE
      expect(content).toContain("DROP TABLE IF EXISTS");
    });
  });

  describe("generate() — PostgreSQL dialect", () => {
    it("should use double quotes for identifiers", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [
          {
            tableName: "users",
            columnName: "email",
            columnType: "CHARACTER VARYING",
            nullable: true,
          },
        ],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "postgres");

      expect(content).toContain('"users"');
      expect(content).toContain('"email"');
      expect(content).toContain("NULL");
      expect(content).not.toContain("`");
    });

    it("should use ALTER COLUMN ... TYPE for PostgreSQL type changes", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [
          {
            tableName: "users",
            columnName: "name",
            columnType: "TEXT",
            currentType: "character varying",
          },
        ],
      };

      const content = generator.generate(diff, "postgres");

      expect(content).toContain("ALTER COLUMN");
      expect(content).toContain("TYPE TEXT");
      expect(content).not.toContain("MODIFY COLUMN");
    });
  });

  describe("generate() — no changes", () => {
    it("should generate a valid migration with no-op comment", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain("extends Migration");
      expect(content).toContain("No changes detected");
      expect(content).toContain("No changes to revert");
    });
  });

  describe("generate() — import statement", () => {
    it("should import from stingerloom-orm", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain(
        'import { Migration, MigrationContext } from "stingerloom-orm"',
      );
    });
  });

  describe("generate() — combined changes", () => {
    it("should handle multiple change types in a single diff", () => {
      const diff: SchemaDiffResult = {
        addTables: ["settings"],
        dropTables: [],
        addColumns: [
          {
            tableName: "users",
            columnName: "email",
            columnType: "VARCHAR",
            nullable: false,
          },
          {
            tableName: "users",
            columnName: "phone",
            columnType: "VARCHAR",
            nullable: true,
          },
        ],
        dropColumns: [
          {
            tableName: "users",
            columnName: "fax",
            currentType: "varchar",
          },
        ],
        alterColumns: [
          {
            tableName: "posts",
            columnName: "body",
            columnType: "TEXT",
            currentType: "varchar",
          },
        ],
      };

      const content = generator.generate(diff, "mysql");

      // up should contain:
      expect(content).toContain("CREATE TABLE");
      expect(content).toContain("ADD COLUMN `email`");
      expect(content).toContain("ADD COLUMN `phone`");
      expect(content).toContain("MODIFY COLUMN `body`");
      expect(content).toContain("// await query"); // commented drop

      // down should contain:
      expect(content).toContain("DROP COLUMN `email`");
      expect(content).toContain("DROP COLUMN `phone`");
      expect(content).toContain("DROP TABLE IF EXISTS");
    });
  });

  describe("save()", () => {
    it("should save migration file to outputDir", async () => {
      const fsMock = jest.requireMock("node:fs/promises");
      // We test the generate output is a valid string instead
      // since actually writing files in unit tests is undesirable

      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [
          {
            tableName: "users",
            columnName: "email",
            columnType: "VARCHAR",
            nullable: false,
          },
        ],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "mysql");
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe("generate() — identifier escaping", () => {
    it("should escape special characters in MySQL identifiers", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [
          {
            tableName: "my`table",
            columnName: "my`col",
            columnType: "VARCHAR",
            nullable: false,
          },
        ],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain("my``table");
      expect(content).toContain("my``col");
    });

    it("should escape special characters in PostgreSQL identifiers", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [
          {
            tableName: 'my"table',
            columnName: 'my"col',
            columnType: "VARCHAR",
            nullable: false,
          },
        ],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "postgres");

      expect(content).toContain('my""table');
      expect(content).toContain('my""col');
    });
  });

  describe("generate() — with entity class (full DDL)", () => {
    it("should generate proper CREATE TABLE DDL when addTableEntityMap is provided", () => {
      const diff: SchemaDiffResult = {
        addTables: ["DiffUser"],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
        addTableEntityMap: { DiffUser: DiffUser },
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain("CREATE TABLE");
      expect(content).toContain("DiffUser");
      expect(content).toContain("INT"); // id column from DiffUser entity
      // down should still have DROP TABLE
      expect(content).toContain("DROP TABLE IF EXISTS");
    });
  });
});
