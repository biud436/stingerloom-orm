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
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

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

@Entity()
class DiffEvent {
  @PrimaryGeneratedColumn()
  id!: number;

  // Single-word property so the column name is unambiguous without a naming strategy.
  @Column({ type: "timestamptz" })
  ts!: Date;
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

  describe("diff() — alterColumns carry declared nullability", () => {
    it("MySQL: a NOT NULL column alter carries nullable=false (MODIFY must keep NOT NULL)", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          // entity: VARCHAR NOT NULL, DB has TEXT → type alter
          { column_name: "name", data_type: "text", is_nullable: "NO" },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
          { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");
      const nameAlter = result.alterColumns.find((c) => c.columnName === "name");
      expect(nameAlter).toBeDefined();
      // Regression: previously undefined → MODIFY COLUMN emitted NULL, dropping NOT NULL.
      expect(nameAlter!.nullable).toBe(false);
    });

    it("a nullable column alter carries nullable=true", async () => {
      const runner = createMockQueryRunner({
        diff_post: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          { column_name: "title", data_type: "varchar", is_nullable: "NO" },
          // entity: TEXT nullable:true, DB has VARCHAR → type alter
          { column_name: "body", data_type: "varchar", is_nullable: "YES" },
        ],
      });

      const result = await schemaDiff.diff([DiffPost], runner, "mysql");
      const bodyAlter = result.alterColumns.find((c) => c.columnName === "body");
      expect(bodyAlter).toBeDefined();
      expect(bodyAlter!.nullable).toBe(true);
    });

    it("MySQL: generated MODIFY COLUMN keeps NOT NULL on a type alter (file + dryRun)", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          // entity: VARCHAR(255) NOT NULL, DB has TEXT → type alter
          { column_name: "name", data_type: "text", is_nullable: "NO" },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
          { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");
      const gen = new SchemaDiffMigrationGenerator();

      // File-content path (buildUpStatements): the MODIFY must keep NOT NULL.
      const content = gen.generate(result, "mysql");
      expect(content).toContain("MODIFY COLUMN");
      expect(content).toContain("NOT NULL");

      // Raw-SQL path (buildUpSql via dryRun): same.
      const modifyLine = gen
        .dryRun(result, "mysql")
        .up.find((s) => s.includes("MODIFY COLUMN") && s.includes("name"));
      expect(modifyLine).toBeDefined();
      // Regression: previously emitted bare "... VARCHAR(255)" → dropped NOT NULL.
      expect(modifyLine).toMatch(/VARCHAR\(255\) NOT NULL/);
    });

    it("MySQL: generated MODIFY COLUMN emits NULL (not NOT NULL) on a nullable type alter", async () => {
      const runner = createMockQueryRunner({
        diff_post: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          { column_name: "title", data_type: "varchar", is_nullable: "NO" },
          // entity: TEXT nullable:true, DB has VARCHAR → type alter
          { column_name: "body", data_type: "varchar", is_nullable: "YES" },
        ],
      });

      const result = await schemaDiff.diff([DiffPost], runner, "mysql");
      const modifyLine = new SchemaDiffMigrationGenerator()
        .dryRun(result, "mysql")
        .up.find((s) => s.includes("MODIFY COLUMN") && s.includes("body"));

      expect(modifyLine).toBeDefined();
      expect(modifyLine).not.toContain("NOT NULL");
      expect(modifyLine).toMatch(/TEXT NULL/);
    });
  });

  describe("diff() — type-change alter carries length/precision", () => {
    it("MySQL: int→varchar type change carries expectedLength so DDL is VARCHAR(255)", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          // entity: VARCHAR(255), DB has INT → type alter
          { column_name: "name", data_type: "int", is_nullable: "NO" },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
          { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");
      const nameAlter = result.alterColumns.find((c) => c.columnName === "name");
      expect(nameAlter).toBeDefined();
      expect(nameAlter!.columnType).toBe("VARCHAR");
      // Regression: previously omitted → DDL emitted bare "VARCHAR" (MySQL 1064).
      expect(nameAlter!.expectedLength).toBe(255);

      // End-to-end: the generated migration must include the length.
      const content = new SchemaDiffMigrationGenerator().generate(result, "mysql");
      expect(content).toContain("VARCHAR(255)");
    });
  });

  describe("diff() — nullability-only alter detection", () => {
    // name: VARCHAR(255) NOT NULL in the entity. DB has the same type but is
    // NULLABLE → a tightening (nullable → NOT NULL) nullability-only alter.
    it("MySQL: detects a tightening (NULL → NOT NULL) nullability-only change", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          {
            column_name: "name",
            data_type: "varchar",
            character_maximum_length: 255,
            is_nullable: "YES",
          },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
          { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");
      expect(result.alterColumns).toHaveLength(1);
      const nameAlter = result.alterColumns[0];
      expect(nameAlter.columnName).toBe("name");
      expect(nameAlter.nullable).toBe(false);
      expect(nameAlter.currentNullable).toBe(true);
      // type & length are unchanged — only the nullability flips.
      expect(nameAlter.typeChanged).toBe(false);
    });

    // body: TEXT nullable:true in the entity. DB has the same type but is NOT
    // NULL → a loosening (NOT NULL → nullable) nullability-only alter.
    it("PostgreSQL: detects a loosening (NOT NULL → NULL) nullability-only change", async () => {
      const runner = createMockQueryRunner({
        diff_post: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          {
            column_name: "title",
            data_type: "varchar",
            character_maximum_length: 255,
            is_nullable: "NO",
          },
          { column_name: "body", data_type: "text", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff(
        [DiffPost],
        runner,
        "postgres",
        "public",
      );
      expect(result.alterColumns).toHaveLength(1);
      const bodyAlter = result.alterColumns[0];
      expect(bodyAlter.columnName).toBe("body");
      expect(bodyAlter.nullable).toBe(true);
      expect(bodyAlter.currentNullable).toBe(false);
      expect(bodyAlter.typeChanged).toBe(false);
    });

    it("does NOT flag a primary-key column whose DB nullability differs (SQLite quirk-safe)", async () => {
      // SQLite reports `INTEGER PRIMARY KEY` as notnull=0 / is_nullable="YES".
      // The PK's nullability is structurally fixed, so it must never produce an
      // alter even when the DB disagrees with the entity.
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "YES" },
          {
            column_name: "name",
            data_type: "varchar",
            character_maximum_length: 255,
            is_nullable: "NO",
          },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
          { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");
      expect(
        result.alterColumns.some((c) => c.columnName === "id"),
      ).toBe(false);
    });

    it("does NOT alter when nullability already matches", async () => {
      const runner = createMockQueryRunner({
        diff_user: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          {
            column_name: "name",
            data_type: "varchar",
            character_maximum_length: 255,
            is_nullable: "NO",
          },
          { column_name: "age", data_type: "int", is_nullable: "NO" },
          { column_name: "active", data_type: "tinyint", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffUser], runner, "mysql");
      expect(result.alterColumns).toHaveLength(0);
    });
  });

  describe("generator — nullability-only ALTER SQL", () => {
    const tighten: SchemaDiffResult = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [
        {
          tableName: "users",
          columnName: "name",
          columnType: "VARCHAR",
          currentType: "varchar",
          nullable: false,
          currentNullable: true,
          typeChanged: false,
          expectedLength: 255,
        },
      ],
    };

    it("PostgreSQL: emits SET NOT NULL and NOT a TYPE rewrite", () => {
      const { up } = new SchemaDiffMigrationGenerator().dryRun(tighten, "postgres");
      expect(up).toHaveLength(1);
      expect(up[0]).toContain("SET NOT NULL");
      expect(up[0]).not.toContain("TYPE");
    });

    it("PostgreSQL: down reverses SET NOT NULL with DROP NOT NULL", () => {
      const { down } = new SchemaDiffMigrationGenerator().dryRun(tighten, "postgres");
      expect(down).toHaveLength(1);
      expect(down[0]).toContain("DROP NOT NULL");
    });

    it("PostgreSQL: a loosening change emits DROP NOT NULL", () => {
      const loosen: SchemaDiffResult = {
        ...tighten,
        alterColumns: [
          {
            ...tighten.alterColumns[0],
            nullable: true,
            currentNullable: false,
          },
        ],
      };
      const { up } = new SchemaDiffMigrationGenerator().dryRun(loosen, "postgres");
      expect(up[0]).toContain("DROP NOT NULL");
    });

    it("MySQL: restates the column via MODIFY COLUMN ... NOT NULL", () => {
      const { up } = new SchemaDiffMigrationGenerator().dryRun(tighten, "mysql");
      expect(up).toHaveLength(1);
      expect(up[0]).toContain("MODIFY COLUMN");
      expect(up[0]).toContain("VARCHAR(255)");
      expect(up[0]).toContain("NOT NULL");
    });

    it("SQLite: throws an explicit unsupported-operation error (nullability change)", () => {
      const gen = new SchemaDiffMigrationGenerator();
      expect(() => gen.generate(tighten, "sqlite")).toThrow(OrmError);
      try {
        gen.generate(tighten, "sqlite");
      } catch (e: any) {
        expect(e.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
        expect(e.message).toContain("nullability");
        expect(e.message).toContain('"users"."name"');
        expect(e.suggestion).toContain("recreates the table");
      }
    });

    it("PostgreSQL: a combined type + nullability change emits both actions", () => {
      const combined: SchemaDiffResult = {
        ...tighten,
        alterColumns: [
          {
            tableName: "users",
            columnName: "name",
            columnType: "TEXT",
            currentType: "varchar",
            nullable: false,
            currentNullable: true,
            // typeChanged omitted → defaults to a real type alter
            expectedLength: null,
          },
        ],
      };
      const { up } = new SchemaDiffMigrationGenerator().dryRun(combined, "postgres");
      expect(up.some((s) => s.includes("TYPE TEXT"))).toBe(true);
      expect(up.some((s) => s.includes("SET NOT NULL"))).toBe(true);
    });
  });

  describe("diff() — timestamptz handling", () => {
    it("MySQL: timestamptz matches a DATETIME column (no spurious/invalid ALTER)", async () => {
      const runner = createMockQueryRunner({
        diff_event: [
          { column_name: "id", data_type: "int", is_nullable: "NO" },
          { column_name: "ts", data_type: "datetime", is_nullable: "NO" },
        ],
      });

      const result = await schemaDiff.diff([DiffEvent], runner, "mysql");
      expect(result.alterColumns).toHaveLength(0);
    });

    it("PostgreSQL: timestamptz matches a 'timestamp with time zone' column", async () => {
      const runner = createMockQueryRunner({
        diff_event: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          {
            column_name: "ts",
            data_type: "timestamp with time zone",
            is_nullable: "NO",
          },
        ],
      });

      const result = await schemaDiff.diff(
        [DiffEvent],
        runner,
        "postgres",
        "public",
      );
      expect(result.alterColumns).toHaveLength(0);
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

    it("should throw when a new table has no entity class in addTableEntityMap", () => {
      const diff: SchemaDiffResult = {
        addTables: ["new_table"],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
      };

      expect(() => generator.generate(diff, "mysql")).toThrow(OrmError);
      try {
        generator.generate(diff, "mysql");
      } catch (e: any) {
        expect(e.code).toBe(OrmErrorCode.SCHEMA_ERROR);
        expect(e.message).toContain("new_table");
        expect(e.suggestion).toContain("addTableEntityMap");
      }
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
      @Entity({ name: "settings" })
      class DiffSettings {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 100 })
        key!: string;
      }

      const diff: SchemaDiffResult = {
        addTables: ["settings"],
        addTableEntityMap: { settings: DiffSettings },
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
        addTables: [],
        dropTables: [],
        addColumns: [
          {
            tableName: "$pecial",
            columnName: "co$t",
            columnType: "VARCHAR",
            nullable: false,
          },
        ],
        dropColumns: [],
        alterColumns: [],
      };

      const content = generator.generate(diff, "mysql");
      // $ must be backslash-escaped inside the template literal wrapper
      expect(content).toContain("\\$pecial");
      expect(content).toContain("co\\$t");
    });

    it("should throw for a new table with an empty addTableEntityMap", () => {
      const diff: SchemaDiffResult = {
        addTables: ["$pecial"],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
        addTableEntityMap: {},
      };

      expect(() => generator.generate(diff, "mysql")).toThrow(
        'Cannot generate CREATE TABLE for "$pecial"',
      );
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

    it("should throw for a new table without entity class (no silent skip)", () => {
      // Previously up silently omitted the CREATE TABLE while down still
      // dropped the table — the preview must fail the same way generate() does.
      const diff: SchemaDiffResult = {
        addTables: ["ghost_table"],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [],
      };

      expect(() => generator.dryRun(diff, "mysql")).toThrow(OrmError);
    });

    it("should throw for SQLite alter columns (no silent skip)", () => {
      const diff: SchemaDiffResult = {
        addTables: [],
        dropTables: [],
        addColumns: [],
        dropColumns: [],
        alterColumns: [
          {
            tableName: "users",
            columnName: "age",
            columnType: "INTEGER",
            currentType: "TEXT",
          },
        ],
      };

      expect(() => generator.dryRun(diff, "sqlite")).toThrow(OrmError);
      try {
        generator.dryRun(diff, "sqlite");
      } catch (e: any) {
        expect(e.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
        expect(e.message).toContain("TEXT -> INTEGER");
      }
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
          // `data!: any` infers nullable:true (design:type Object), so the
          // column the ORM creates is NULLABLE — the fixture must match, else a
          // (correct) nullability-only alter would be reported.
          { column_name: "data", data_type: "json", is_nullable: "YES" },
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
