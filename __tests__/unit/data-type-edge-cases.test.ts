/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

/**
 * Tests for data-type edge cases (#133).
 *
 * These tests verify that SchemaGenerator.generateCreateTableDDL() produces
 * correct DB-specific type names for each dialect. The Column decorator infers
 * default length from design:type (e.g. String → 255, Boolean → 1), so we
 * set `length: 0` where we want to verify the bare type name without a suffix.
 */
describe("Data-type edge cases (#133)", () => {
  // ─────────────────────────────────────────────────
  // 1. BigInt
  // ─────────────────────────────────────────────────
  describe("BigInt column type", () => {
    it("MySQL: should produce BIGINT", () => {
      @Entity()
      class BigIntMysql {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "bigint", length: 0 })
        largeNumber!: number;
      }

      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddl = gen.generateCreateTableDDL(BigIntMysql);
      expect(ddl).toContain("BIGINT");
      expect(ddl).toMatch(/`largeNumber`\s+BIGINT\s+NOT NULL/);
    });

    it("PostgreSQL: should produce BIGINT", () => {
      @Entity()
      class BigIntPostgres {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "bigint", length: 0 })
        largeNumber!: number;
      }

      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddl = gen.generateCreateTableDDL(BigIntPostgres);
      expect(ddl).toContain("BIGINT");
      expect(ddl).toMatch(/"largeNumber"\s+BIGINT\s+NOT NULL/);
    });

    it("SQLite: should produce INTEGER (bigint maps to INTEGER)", () => {
      @Entity()
      class BigIntSqlite {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "bigint", length: 0 })
        largeNumber!: number;
      }

      const gen = new SchemaGenerator({ dialect: "sqlite" });
      const ddl = gen.generateCreateTableDDL(BigIntSqlite);
      // SQLite maps bigint to INTEGER
      expect(ddl).toMatch(/"largeNumber"\s+INTEGER\s+NOT NULL/);
    });

    it("BigInt column should respect nullable option", () => {
      @Entity()
      class BigIntNullable {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "bigint", nullable: true, length: 0 })
        optionalBigInt!: number;
      }

      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddl = gen.generateCreateTableDDL(BigIntNullable);
      expect(ddl).toMatch(/`optionalBigInt`\s+BIGINT\s+NULL/);
    });
  });

  // ─────────────────────────────────────────────────
  // 2. JSON / JSONB
  // ─────────────────────────────────────────────────
  describe("JSON / JSONB column types", () => {
    it("MySQL: json should produce JSON", () => {
      @Entity()
      class JsonMysql {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "json", length: 0 })
        data!: string;
      }

      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddl = gen.generateCreateTableDDL(JsonMysql);
      expect(ddl).toMatch(/`data`\s+JSON\s+NOT NULL/);
    });

    it("MySQL: jsonb should fallback to JSON", () => {
      @Entity()
      class JsonbMysqlFallback {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "jsonb", length: 0 })
        payload!: string;
      }

      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddl = gen.generateCreateTableDDL(JsonbMysqlFallback);
      // MySQL does not have JSONB; it falls back to JSON
      expect(ddl).toMatch(/`payload`\s+JSON\s+NOT NULL/);
      expect(ddl).not.toContain("JSONB");
    });

    it("PostgreSQL: json should produce JSON", () => {
      @Entity()
      class JsonPostgres {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "json", length: 0 })
        data!: string;
      }

      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddl = gen.generateCreateTableDDL(JsonPostgres);
      expect(ddl).toMatch(/"data"\s+JSON\s+NOT NULL/);
    });

    it("PostgreSQL: jsonb should produce JSONB", () => {
      @Entity()
      class JsonbPostgres {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "jsonb", length: 0 })
        payload!: string;
      }

      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddl = gen.generateCreateTableDDL(JsonbPostgres);
      expect(ddl).toMatch(/"payload"\s+JSONB\s+NOT NULL/);
    });

    it("SQLite: json and jsonb should both produce TEXT", () => {
      @Entity()
      class JsonSqlite {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "json", length: 0 })
        jsonCol!: string;

        @Column({ type: "jsonb", length: 0 })
        jsonbCol!: string;
      }

      const gen = new SchemaGenerator({ dialect: "sqlite" });
      const ddl = gen.generateCreateTableDDL(JsonSqlite);
      expect(ddl).toMatch(/"jsonCol"\s+TEXT\s+NOT NULL/);
      expect(ddl).toMatch(/"jsonbCol"\s+TEXT\s+NOT NULL/);
    });

    it("nullable JSON column should produce NULL constraint", () => {
      @Entity()
      class JsonNullable {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "json", nullable: true, length: 0 })
        metadata!: string;
      }

      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddl = gen.generateCreateTableDDL(JsonNullable);
      expect(ddl).toMatch(/"metadata"\s+JSON\s+NULL/);
    });
  });

  // ─────────────────────────────────────────────────
  // 3. ENUM
  // ─────────────────────────────────────────────────
  describe("ENUM column type", () => {
    it("MySQL: enum should produce ENUM type", () => {
      @Entity()
      class EnumMysql {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "enum", enumValues: ["active", "inactive"], length: 0 })
        status!: string;
      }

      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddl = gen.generateCreateTableDDL(EnumMysql);
      // SchemaGenerator castTypeMysql returns "ENUM" for enum type
      expect(ddl).toContain("ENUM");
      expect(ddl).toMatch(/`status`\s+ENUM/);
    });

    it("PostgreSQL: enum with enumName should use quoted enum type name", () => {
      @Entity()
      class EnumPgNamed {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "enum", enumName: "user_status", enumValues: ["active", "inactive"], length: 0 })
        status!: string;
      }

      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddl = gen.generateCreateTableDDL(EnumPgNamed);
      // PostgreSQL uses the enumName as a custom type, wrapped with schema qualification
      expect(ddl).toContain('"public"."user_status"');
    });

    it("PostgreSQL: enum without enumName should auto-generate enum type name", () => {
      @Entity()
      class EnumPgAuto {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "enum", enumValues: ["draft", "published"], length: 0 })
        state!: string;
      }

      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddl = gen.generateCreateTableDDL(EnumPgAuto);
      // Auto-generated name: ${tableName}_${columnName}_enum
      expect(ddl).toMatch(/"public"\."enum_pg_auto_state_enum"/);
    });

    it("SQLite: enum should produce TEXT", () => {
      @Entity()
      class EnumSqlite {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "enum", enumValues: ["a", "b", "c"], length: 0 })
        category!: string;
      }

      const gen = new SchemaGenerator({ dialect: "sqlite" });
      const ddl = gen.generateCreateTableDDL(EnumSqlite);
      // SQLite maps enum to TEXT
      expect(ddl).toMatch(/"category"\s+TEXT\s+NOT NULL/);
    });
  });

  // ─────────────────────────────────────────────────
  // 4. Boolean
  // ─────────────────────────────────────────────────
  describe("Boolean column type", () => {
    it("MySQL: boolean should produce TINYINT(1)", () => {
      @Entity()
      class BoolMysql {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "boolean" })
        isActive!: boolean;
      }

      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddl = gen.generateCreateTableDDL(BoolMysql);
      expect(ddl).toContain("TINYINT(1)");
      expect(ddl).toMatch(/`isActive`\s+TINYINT\(1\)\s+NOT NULL/);
    });

    it("PostgreSQL: boolean should produce BOOLEAN", () => {
      @Entity()
      class BoolPostgres {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "boolean", length: 0 })
        isActive!: boolean;
      }

      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddl = gen.generateCreateTableDDL(BoolPostgres);
      expect(ddl).toMatch(/"isActive"\s+BOOLEAN\s+NOT NULL/);
    });

    it("SQLite: boolean should produce INTEGER", () => {
      @Entity()
      class BoolSqlite {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "boolean", length: 0 })
        isActive!: boolean;
      }

      const gen = new SchemaGenerator({ dialect: "sqlite" });
      const ddl = gen.generateCreateTableDDL(BoolSqlite);
      // SQLite maps boolean to INTEGER
      expect(ddl).toMatch(/"isActive"\s+INTEGER\s+NOT NULL/);
    });

    it("nullable boolean should produce NULL constraint", () => {
      @Entity()
      class BoolNullable {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "boolean", nullable: true })
        optIn!: boolean;
      }

      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddl = gen.generateCreateTableDDL(BoolNullable);
      expect(ddl).toMatch(/`optIn`\s+TINYINT\(1\)\s+NULL/);
    });
  });

  // ─────────────────────────────────────────────────
  // 5. Timestamp / Timestamptz
  // ─────────────────────────────────────────────────
  describe("Timestamp vs Timestamptz column types", () => {
    it("MySQL: timestamp should produce TIMESTAMP", () => {
      @Entity()
      class TsMysql {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "timestamp", length: 0 })
        createdAt!: Date;
      }

      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddl = gen.generateCreateTableDDL(TsMysql);
      expect(ddl).toMatch(/`createdAt`\s+TIMESTAMP\s+NOT NULL/);
    });

    it("MySQL: timestamptz should fall back to DATETIME", () => {
      @Entity()
      class TstzMysql {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "timestamptz", length: 0 })
        createdAt!: Date;
      }

      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddl = gen.generateCreateTableDDL(TstzMysql);
      // MySQL does not have TIMESTAMPTZ; castTypeMysql maps it to DATETIME
      expect(ddl).toMatch(/`createdAt`\s+DATETIME\s+NOT NULL/);
      expect(ddl).not.toContain("TIMESTAMPTZ");
    });

    it("PostgreSQL: timestamp should produce TIMESTAMP", () => {
      @Entity()
      class TsPostgres {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "timestamp", length: 0 })
        createdAt!: Date;
      }

      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddl = gen.generateCreateTableDDL(TsPostgres);
      expect(ddl).toMatch(/"createdAt"\s+TIMESTAMP\s+NOT NULL/);
    });

    it("PostgreSQL: timestamptz should produce TIMESTAMPTZ", () => {
      @Entity()
      class TstzPostgres {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "timestamptz", length: 0 })
        updatedAt!: Date;
      }

      const gen = new SchemaGenerator({ dialect: "postgres" });
      const ddl = gen.generateCreateTableDDL(TstzPostgres);
      expect(ddl).toMatch(/"updatedAt"\s+TIMESTAMPTZ\s+NOT NULL/);
    });

    it("SQLite: timestamp and timestamptz should both produce TEXT", () => {
      @Entity()
      class TsSqlite {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "timestamp", length: 0 })
        ts!: Date;

        @Column({ type: "timestamptz", length: 0 })
        tstz!: Date;
      }

      const gen = new SchemaGenerator({ dialect: "sqlite" });
      const ddl = gen.generateCreateTableDDL(TsSqlite);
      // SQLite maps all timestamp variants to TEXT
      expect(ddl).toMatch(/"ts"\s+TEXT\s+NOT NULL/);
      expect(ddl).toMatch(/"tstz"\s+TEXT\s+NOT NULL/);
    });
  });
});
