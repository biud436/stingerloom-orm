/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaDiff, EnumChange } from "../../src/core/generators/SchemaDiff";
import {
  SchemaDiffMigrationGenerator,
} from "../../src/core/generators/SchemaDiffMigrationGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

// ─────────────────────────────────────────────────
// Test entities with ENUM columns
// ─────────────────────────────────────────────────

@Entity()
class EnumUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({
    type: "enum",
    enumName: "user_role",
    enumValues: ["admin", "user", "guest"],
  })
  role!: string;
}

@Entity()
class EnumOrder {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    type: "enum",
    enumName: "order_status",
    enumValues: ["pending", "shipped", "delivered", "cancelled"],
  })
  status!: string;
}

// ─────────────────────────────────────────────────
// Mock query runner
// ─────────────────────────────────────────────────

function createMockQueryRunner(
  responseMap: Record<string, any[]>,
): { query: jest.Mock } {
  const mockQuery = jest.fn((sqlInput: string | { text?: string; sql?: string; values?: any[] }) => {
    const sqlText = typeof sqlInput === "string"
      ? sqlInput
      : (sqlInput.text ?? sqlInput.sql ?? "");
    const values = typeof sqlInput === "object" && sqlInput !== null
      ? (sqlInput.values ?? [])
      : [];
    for (const [key, value] of Object.entries(responseMap)) {
      if (sqlText.includes(key) || values.some((v: any) => String(v).includes(key))) {
        return Promise.resolve(value);
      }
    }
    return Promise.resolve([]);
  });
  return { query: mockQuery };
}

// ─────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────

describe("SchemaDiff — PostgreSQL ENUM auto-sync", () => {
  let schemaDiff: SchemaDiff;

  beforeEach(() => {
    schemaDiff = new SchemaDiff();
  });

  describe("new table with enum columns", () => {
    it("should detect new enum types when table is new", async () => {
      const runner = createMockQueryRunner({});
      const result = await schemaDiff.diff([EnumUser], runner, "postgres");

      expect(result.addTables).toContain("enum_user");
      expect(result.enumChanges).toBeDefined();
      expect(result.enumChanges!.length).toBe(1);

      const ec = result.enumChanges![0];
      expect(ec.enumName).toBe("user_role");
      expect(ec.isNew).toBe(true);
      expect(ec.addValues).toEqual(["admin", "user", "guest"]);
      expect(ec.removeValues).toEqual([]);
    });

    it("should detect multiple new enum types across entities", async () => {
      const runner = createMockQueryRunner({});
      const result = await schemaDiff.diff([EnumUser, EnumOrder], runner, "postgres");

      expect(result.enumChanges!.length).toBe(2);
      const enumNames = result.enumChanges!.map((e) => e.enumName);
      expect(enumNames).toContain("user_role");
      expect(enumNames).toContain("order_status");
    });
  });

  describe("existing table with added enum values", () => {
    it("should detect added enum values", async () => {
      // Table exists with columns, but enum has fewer values
      const runner = createMockQueryRunner({
        // Return columns for existing table
        enum_user: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          { column_name: "name", data_type: "character varying", is_nullable: "NO" },
          { column_name: "role", data_type: "USER-DEFINED", is_nullable: "NO" },
        ],
        // Return existing enum values
        user_role: [
          { enumlabel: "admin" },
          { enumlabel: "user" },
        ],
      });

      const result = await schemaDiff.diff([EnumUser], runner, "postgres");

      expect(result.addTables).toHaveLength(0);
      expect(result.enumChanges!.length).toBe(1);

      const ec = result.enumChanges![0];
      expect(ec.enumName).toBe("user_role");
      expect(ec.isNew).toBe(false);
      expect(ec.addValues).toEqual(["guest"]);
      expect(ec.removeValues).toEqual([]);
    });
  });

  describe("existing table with removed enum values", () => {
    it("should detect removed enum values", async () => {
      const runner = createMockQueryRunner({
        enum_user: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          { column_name: "name", data_type: "character varying", is_nullable: "NO" },
          { column_name: "role", data_type: "USER-DEFINED", is_nullable: "NO" },
        ],
        user_role: [
          { enumlabel: "admin" },
          { enumlabel: "user" },
          { enumlabel: "guest" },
          { enumlabel: "superadmin" },
        ],
      });

      const result = await schemaDiff.diff([EnumUser], runner, "postgres");

      const ec = result.enumChanges![0];
      expect(ec.isNew).toBe(false);
      expect(ec.addValues).toEqual([]);
      expect(ec.removeValues).toEqual(["superadmin"]);
    });
  });

  describe("no changes when enum values match", () => {
    it("should not report changes when values are identical", async () => {
      const runner = createMockQueryRunner({
        enum_user: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          { column_name: "name", data_type: "character varying", is_nullable: "NO" },
          { column_name: "role", data_type: "USER-DEFINED", is_nullable: "NO" },
        ],
        user_role: [
          { enumlabel: "admin" },
          { enumlabel: "user" },
          { enumlabel: "guest" },
        ],
      });

      const result = await schemaDiff.diff([EnumUser], runner, "postgres");

      expect(result.enumChanges).toHaveLength(0);
    });
  });

  describe("enum on existing table where type does not exist yet", () => {
    it("should mark enum as isNew when type is missing in DB", async () => {
      // Table exists but enum type doesn't exist yet (new column being added)
      const runner = createMockQueryRunner({
        enum_user: [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          { column_name: "name", data_type: "character varying", is_nullable: "NO" },
          // role column missing — it's a new column
        ],
        // No enum values returned → type does not exist
      });

      const result = await schemaDiff.diff([EnumUser], runner, "postgres");

      expect(result.enumChanges!.length).toBe(1);
      const ec = result.enumChanges![0];
      expect(ec.enumName).toBe("user_role");
      expect(ec.isNew).toBe(true);
      expect(ec.addValues).toEqual(["admin", "user", "guest"]);
    });
  });

  describe("MySQL dialect — no enum changes", () => {
    it("should not generate enumChanges for MySQL", async () => {
      const runner = createMockQueryRunner({});
      const result = await schemaDiff.diff([EnumUser], runner, "mysql");

      expect(result.enumChanges).toHaveLength(0);
    });
  });

  describe("SQLite dialect — no enum changes", () => {
    it("should not generate enumChanges for SQLite", async () => {
      // SQLite PRAGMA for existing table with columns
      const runner = createMockQueryRunner({
        enum_user: [
          { name: "id", type: "INTEGER", notnull: 1 },
          { name: "name", type: "TEXT", notnull: 1 },
          { name: "role", type: "TEXT", notnull: 1 },
        ],
      });
      const result = await schemaDiff.diff([EnumUser], runner, "sqlite");

      expect(result.enumChanges).toHaveLength(0);
    });
  });
});

describe("SchemaDiffMigrationGenerator — ENUM DDL generation", () => {
  let generator: SchemaDiffMigrationGenerator;

  beforeEach(() => {
    generator = new SchemaDiffMigrationGenerator();
  });

  it("should generate CREATE TYPE for new enums", () => {
    const diff = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
      enumChanges: [
        {
          enumName: "user_role",
          addValues: ["admin", "user", "guest"],
          removeValues: [],
          isNew: true,
        },
      ],
    };

    const { up } = generator.dryRun(diff, "postgres");
    expect(up[0]).toBe(`CREATE TYPE "user_role" AS ENUM ('admin', 'user', 'guest')`);
  });

  it("should generate ALTER TYPE ADD VALUE IF NOT EXISTS for updated enums", () => {
    const diff = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
      enumChanges: [
        {
          enumName: "user_role",
          addValues: ["moderator", "editor"],
          removeValues: [],
          isNew: false,
        },
      ],
    };

    const { up } = generator.dryRun(diff, "postgres");
    expect(up).toContain(`ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'moderator'`);
    expect(up).toContain(`ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'editor'`);
  });

  it("should generate a warning comment for removed enum values", () => {
    const diff = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
      enumChanges: [
        {
          enumName: "user_role",
          addValues: [],
          removeValues: ["superadmin"],
          isNew: false,
        },
      ],
    };

    const { up } = generator.dryRun(diff, "postgres");
    expect(up[0]).toContain("WARNING");
    expect(up[0]).toContain("superadmin");
  });

  it("should generate DROP TYPE in down migration for new enums", () => {
    const diff = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
      enumChanges: [
        {
          enumName: "order_status",
          addValues: ["pending", "shipped"],
          removeValues: [],
          isNew: true,
        },
      ],
    };

    const { down } = generator.dryRun(diff, "postgres");
    expect(down[0]).toBe(`DROP TYPE IF EXISTS "order_status"`);
  });

  it("should not generate ENUM DDL for MySQL dialect", () => {
    const diff = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
      enumChanges: [
        {
          enumName: "user_role",
          addValues: ["admin"],
          removeValues: [],
          isNew: true,
        },
      ],
    };

    const { up } = generator.dryRun(diff, "mysql");
    // No ENUM DDL for MySQL — only column-level ENUM is used
    expect(up.some((s) => s.includes("CREATE TYPE"))).toBe(false);
  });

  it("should escape single quotes in enum values", () => {
    const diff = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
      enumChanges: [
        {
          enumName: "label_type",
          addValues: ["it's_special"],
          removeValues: [],
          isNew: true,
        },
      ],
    };

    const { up } = generator.dryRun(diff, "postgres");
    expect(up[0]).toContain("it''s_special");
  });
});
