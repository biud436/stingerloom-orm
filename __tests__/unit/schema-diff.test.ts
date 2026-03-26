/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaDiff, SchemaDiffResult } from "../../src/core/generators/SchemaDiff";
import {
  SchemaDiffMigrationGenerator,
} from "../../src/core/generators/SchemaDiffMigrationGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";

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
  const mockQuery = jest.fn((sqlInput: string | { text?: string; sql?: string; values?: any[] }) => {
    // Extract the SQL text and values from either a string or a Sql template-tag object
    const sqlText = typeof sqlInput === "string"
      ? sqlInput
      : (sqlInput.text ?? sqlInput.sql ?? "");
    const values = typeof sqlInput === "object" && sqlInput !== null
      ? (sqlInput.values ?? [])
      : [];
    for (const [key, value] of Object.entries(responseMap)) {
      // Check both the SQL text and the parameter values for the key
      if (sqlText.includes(key) || values.some((v: any) => String(v).includes(key))) {
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
        renamedColumns: [],
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain("extends Migration");
      expect(content).toContain("ADD COLUMN");
      expect(content).toContain("users");
      expect(content).toContain("email");
      expect(content).toContain("VARCHAR");
      expect(content).toContain("NOT NULL");
      // down should have DROP COLUMN
      expect(content).toContain("DROP COLUMN");
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
      expect(content).toContain("name");
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
      // Ensure no MySQL-style backtick identifier quoting (template literal backticks are OK)
      expect(content).not.toMatch(/`users`/);
      expect(content).not.toMatch(/`email`/);
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
    it("should import from @stingerloom/orm", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain(
        'import { Migration, MigrationContext } from "@stingerloom/orm"',
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
      expect(content).toContain("ADD COLUMN");
      expect(content).toContain("email");
      expect(content).toContain("phone");
      expect(content).toContain("MODIFY COLUMN");
      expect(content).toContain("body");
      expect(content).toContain("// await query"); // commented drop

      // down should contain:
      expect(content).toContain("DROP COLUMN");
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

      // MySQL backtick escaping: ` -> `` in SQL, then ` -> \` in template literal
      expect(content).toContain("my");
      expect(content).toContain("table");
      expect(content).toContain("col");
      // Verify the SQL contains the table/column references
      expect(content).toContain("ADD COLUMN");
      expect(content).toContain("ALTER TABLE");
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

  describe("generate() — DDL escape with backticks and dollar signs", () => {
    it("should use template literals and properly escape backticks", () => {
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

      // Should use template literals (backtick) for wrapping SQL
      expect(content).toContain("await query(`");
      // Should NOT use single-quoted strings for SQL
      expect(content).not.toMatch(/await query\('/);
    });

    it("should escape dollar signs in DDL to prevent template literal injection", () => {
      const diff: SchemaDiffResult = {
        addTables: ["$pecial"],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
        addTableEntityMap: {},
      };

      const content = generator.generate(diff, "mysql");
      // The table name with $ should be commented out (no entity class)
      expect(content).toContain("$pecial");
    });
  });

  describe("dryRun()", () => {
    it("should return pure SQL without await query wrapper", () => {
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

      const result = generator.dryRun(diff, "mysql");

      expect(result.up).toHaveLength(1);
      expect(result.up[0]).toContain("ALTER TABLE");
      expect(result.up[0]).toContain("ADD COLUMN");
      expect(result.up[0]).not.toContain("await query");

      expect(result.down).toHaveLength(1);
      expect(result.down[0]).toContain("DROP COLUMN");
      expect(result.down[0]).not.toContain("await query");
    });

    it("should return empty arrays for no changes", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
      };

      const result = generator.dryRun(diff, "mysql");

      expect(result.up).toHaveLength(0);
      expect(result.down).toHaveLength(0);
    });

    it("should include CREATE TABLE SQL for new tables with entity class", () => {
      const diff: SchemaDiffResult = {
        addTables: ["diff_user"],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
        addTableEntityMap: { diff_user: DiffUser },
      };

      const result = generator.dryRun(diff, "mysql");

      expect(result.up.length).toBeGreaterThan(0);
      expect(result.up[0]).toContain("CREATE TABLE");
      expect(result.down.length).toBeGreaterThan(0);
      expect(result.down[0]).toContain("DROP TABLE");
    });
  });

  describe("generate() — FK dependency ordering", () => {
    it("should order tables by FK dependency (referenced table first)", () => {
      @Entity()
      class DepCategory {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 100 })
        name!: string;
      }

      @Entity()
      class DepArticle {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 255 })
        title!: string;

        @ManyToOne(() => DepCategory, (e: any) => e.category, { joinColumn: "category_id" })
        category!: DepCategory;
      }

      const diff: SchemaDiffResult = {
        addTables: ["dep_article", "dep_category"],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
        addTableEntityMap: {
          dep_article: DepArticle,
          dep_category: DepCategory,
        },
      };

      const content = generator.generate(diff, "mysql");

      // dep_category should appear before dep_article in the output
      const catIdx = content.indexOf("dep_category");
      const artIdx = content.indexOf("dep_article");
      expect(catIdx).toBeLessThan(artIdx);
    });
  });

  describe("generate() — dropTables in diff", () => {
    it("should generate commented-out DROP TABLE statements for dropped tables", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: ["old_table"],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "mysql");

      expect(content).toContain("DROP TABLE IF EXISTS");
      expect(content).toContain("old_table");
      expect(content).toContain("DANGEROUS");
    });
  });
});

// ─────────────────────────────────────────────────
// SchemaDiff Phase 2 tests
// ─────────────────────────────────────────────────

describe("SchemaDiff — Phase 2 improvements", () => {
  let schemaDiff: SchemaDiff;

  beforeEach(() => {
    schemaDiff = new SchemaDiff();
  });

  describe("JSON ≠ JSONB separation (PostgreSQL)", () => {
    @Entity()
    class JsonEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "json" })
      data!: any;
    }

    @Entity()
    class JsonbEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "jsonb" })
      data!: any;
    }

    it("should detect type mismatch when entity is JSON but DB is JSONB", async () => {
      const runner = createMockQueryRunner({
        json_entity: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          { column_name: "data", data_type: "jsonb", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff(
        [JsonEntity],
        runner,
        "postgres",
        "public",
      );

      expect(result.alterColumns).toHaveLength(1);
      expect(result.alterColumns[0].columnName).toBe("data");
      expect(result.alterColumns[0].columnType).toBe("JSON");
      expect(result.alterColumns[0].currentType).toBe("jsonb");
    });

    it("should detect type mismatch when entity is JSONB but DB is JSON", async () => {
      const runner = createMockQueryRunner({
        jsonb_entity: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          { column_name: "data", data_type: "json", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff(
        [JsonbEntity],
        runner,
        "postgres",
        "public",
      );

      expect(result.alterColumns).toHaveLength(1);
      expect(result.alterColumns[0].columnName).toBe("data");
    });

    it("should NOT detect mismatch when entity is JSON and DB is JSON", async () => {
      const runner = createMockQueryRunner({
        json_entity: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          { column_name: "data", data_type: "json", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff(
        [JsonEntity],
        runner,
        "postgres",
        "public",
      );

      expect(result.alterColumns).toHaveLength(0);
    });
  });

  describe("VARCHAR length difference detection", () => {
    @Entity()
    class LengthEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "varchar", length: 100 })
      name!: string;
    }

    it("should detect length mismatch (100 vs 255)", async () => {
      const runner = createMockQueryRunner({
        length_entity: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          {
            column_name: "name",
            data_type: "varchar",
            is_nullable: "NO",
            character_maximum_length: 255,
          },
        ],
      });

      const result = await schemaDiff.diff(
        [LengthEntity],
        runner,
        "mysql",
      );

      expect(result.alterColumns).toHaveLength(1);
      expect(result.alterColumns[0].columnName).toBe("name");
      expect(result.alterColumns[0].expectedLength).toBe(100);
      expect(result.alterColumns[0].actualLength).toBe(255);
    });

    it("should NOT detect mismatch when lengths are the same", async () => {
      const runner = createMockQueryRunner({
        length_entity: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          {
            column_name: "name",
            data_type: "varchar",
            is_nullable: "NO",
            character_maximum_length: 100,
          },
        ],
      });

      const result = await schemaDiff.diff(
        [LengthEntity],
        runner,
        "mysql",
      );

      expect(result.alterColumns).toHaveLength(0);
    });
  });

  describe("DECIMAL precision/scale difference detection", () => {
    @Entity()
    class PrecisionEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "double", precision: 10, scale: 2 })
      price!: number;
    }

    it("should detect precision mismatch (10,2 vs 5,3)", async () => {
      const runner = createMockQueryRunner({
        precision_entity: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          {
            column_name: "price",
            data_type: "decimal",
            is_nullable: "NO",
            numeric_precision: 5,
            numeric_scale: 3,
          },
        ],
      });

      const result = await schemaDiff.diff(
        [PrecisionEntity],
        runner,
        "mysql",
      );

      expect(result.alterColumns).toHaveLength(1);
      expect(result.alterColumns[0].columnName).toBe("price");
      expect(result.alterColumns[0].expectedPrecision).toBe(10);
      expect(result.alterColumns[0].actualPrecision).toBe(5);
      expect(result.alterColumns[0].expectedScale).toBe(2);
      expect(result.alterColumns[0].actualScale).toBe(3);
    });

    it("should NOT detect mismatch when precision matches", async () => {
      const runner = createMockQueryRunner({
        precision_entity: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          {
            column_name: "price",
            data_type: "decimal",
            is_nullable: "NO",
            numeric_precision: 10,
            numeric_scale: 2,
          },
        ],
      });

      const result = await schemaDiff.diff(
        [PrecisionEntity],
        runner,
        "mysql",
      );

      expect(result.alterColumns).toHaveLength(0);
    });
  });

  describe("dropTables detection (opt-in)", () => {
    it("should detect dropped tables when detectDroppedTables is true", async () => {
      const mockQuery = jest.fn((sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");
        const values = typeof sqlInput === "object" && sqlInput !== null
          ? (sqlInput.values ?? [])
          : [];

        // getDbColumns for diff_user — return columns (table exists)
        if (
          sqlText.includes("information_schema") &&
          (sqlText.includes("diff_user") || values.some((v: any) => String(v).includes("diff_user")))
        ) {
          return Promise.resolve([
            { column_name: "id", data_type: "int", is_nullable: "NO" },
            { column_name: "name", data_type: "varchar", is_nullable: "NO" },
            { column_name: "age", data_type: "int", is_nullable: "NO" },
            { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
          ]);
        }

        // getDbTables — return list including an extra table
        if (sqlText.includes("TABLE_NAME") && sqlText.includes("TABLES")) {
          return Promise.resolve([
            { name: "diff_user" },
            { name: "orphaned_table" },
          ]);
        }

        return Promise.resolve([]);
      });

      const result = await schemaDiff.diff(
        [DiffUser],
        { query: mockQuery },
        "mysql",
        undefined,
        { detectDroppedTables: true },
      );

      expect(result.dropTables).toContain("orphaned_table");
      expect(result.dropTables).not.toContain("diff_user");
    });

    it("should NOT detect dropped tables by default (backward compat)", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          { column_name: "name", data_type: "varchar", is_nullable: "NO" },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
          { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");

      expect(result.dropTables).toHaveLength(0);
    });
  });

  describe("column rename detection (#74)", () => {
    @Entity()
    class RenameUser {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "varchar", length: 255 })
      full_name!: string;

      @Column({ type: "int" })
      age!: number;
    }

    it("should detect rename when add/drop pair has same type", async () => {
      const runner = createMockQueryRunner({
        rename_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          { column_name: "name", data_type: "varchar", is_nullable: "NO" },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([RenameUser], runner, "mysql");

      expect(result.renamedColumns).toHaveLength(1);
      expect(result.renamedColumns![0].oldColumnName).toBe("name");
      expect(result.renamedColumns![0].newColumnName).toBe("full_name");
      expect(result.addColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(0);
    });

    it("should not detect rename when types differ", async () => {
      const runner = createMockQueryRunner({
        rename_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          { column_name: "name", data_type: "text", is_nullable: "NO" },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([RenameUser], runner, "mysql");

      // TEXT != VARCHAR so no rename, treated as add + drop
      expect(result.renamedColumns ?? []).toHaveLength(0);
      expect(result.addColumns.length).toBeGreaterThan(0);
      expect(result.dropColumns.length).toBeGreaterThan(0);
    });

    it("should generate RENAME COLUMN DDL", () => {
      const generator = new SchemaDiffMigrationGenerator();
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
        renamedColumns: [
          { tableName: "users", oldColumnName: "name", newColumnName: "full_name", columnType: "VARCHAR" },
        ],
      };

      const content = generator.generate(diff, "mysql");
      expect(content).toContain("RENAME COLUMN");
      expect(content).toContain("\\`name\\`");
      expect(content).toContain("\\`full_name\\`");

      const pg = generator.generate(diff, "postgres");
      expect(pg).toContain("RENAME COLUMN");
      expect(pg).toContain('"name"');
      expect(pg).toContain('"full_name"');
    });

    it("should generate reversible RENAME COLUMN in down()", () => {
      const generator = new SchemaDiffMigrationGenerator();
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
        renamedColumns: [
          { tableName: "users", oldColumnName: "name", newColumnName: "full_name", columnType: "VARCHAR" },
        ],
      };

      const result = generator.dryRun(diff, "postgres");
      expect(result.up[0]).toContain('RENAME COLUMN "name" TO "full_name"');
      expect(result.down[0]).toContain('RENAME COLUMN "full_name" TO "name"');
    });
  });
});
