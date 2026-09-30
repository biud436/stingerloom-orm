/* eslint-disable @typescript-eslint/no-explicit-any */
import { IntrospectionTypeMapper } from "../../src/introspection/TypeMapper";
import {
  EntityCodeBuilder,
  DbColumn,
  DbForeignKey,
  DbIndex,
} from "../../src/introspection/EntityCodeBuilder";
import {
  IntrospectionGenerator,
} from "../../src/introspection/IntrospectionGenerator";

// ─── TypeMapper tests ────────────────────────────────────────

describe("IntrospectionTypeMapper", () => {
  describe("PostgreSQL type mappings", () => {
    const cases: Array<[string, string]> = [
      ["INTEGER", "int"],
      ["INT4", "int"],
      ["BIGINT", "bigint"],
      ["INT8", "bigint"],
      ["BOOLEAN", "boolean"],
      ["BOOL", "boolean"],
      ["CHARACTER VARYING", "varchar"],
      ["VARCHAR", "varchar"],
      ["TEXT", "text"],
      ["TIMESTAMP WITHOUT TIME ZONE", "timestamp"],
      ["TIMESTAMP", "timestamp"],
      ["TIMESTAMP WITH TIME ZONE", "timestamptz"],
      ["TIMESTAMPTZ", "timestamptz"],
      ["DATE", "date"],
      ["JSONB", "jsonb"],
      ["JSON", "json"],
      ["BYTEA", "blob"],
      ["REAL", "float"],
      ["FLOAT4", "float"],
      ["NUMERIC", "double"],
      ["DOUBLE PRECISION", "double"],
      ["CHARACTER", "char"],
      ["BPCHAR", "char"],
      ["USER-DEFINED", "enum"],
      ["ARRAY", "array"],
      ["SERIAL", "int"],
      ["BIGSERIAL", "bigint"],
    ];

    it.each(cases)("should map %s to %s", (dbType, expected) => {
      expect(IntrospectionTypeMapper.toColumnType(dbType, "postgres")).toBe(expected);
    });

    it("should return varchar for unknown PostgreSQL types", () => {
      expect(IntrospectionTypeMapper.toColumnType("UNKNOWN_TYPE", "postgres")).toBe("varchar");
    });
  });

  describe("MySQL type mappings", () => {
    const cases: Array<[string, string]> = [
      ["INT", "int"],
      ["INTEGER", "int"],
      ["TINYINT", "boolean"],
      ["BIGINT", "bigint"],
      ["VARCHAR", "varchar"],
      ["CHAR", "char"],
      ["TEXT", "text"],
      ["LONGTEXT", "longtext"],
      ["DATETIME", "datetime"],
      ["TIMESTAMP", "timestamp"],
      ["DATE", "date"],
      ["JSON", "json"],
      ["BLOB", "blob"],
      ["ENUM", "enum"],
      ["FLOAT", "float"],
      ["DOUBLE", "double"],
      ["DECIMAL", "double"],
    ];

    it.each(cases)("should map %s to %s", (dbType, expected) => {
      expect(IntrospectionTypeMapper.toColumnType(dbType, "mysql")).toBe(expected);
    });

    it("should return varchar for unknown MySQL types", () => {
      expect(IntrospectionTypeMapper.toColumnType("GEOMETRY", "mysql")).toBe("varchar");
    });
  });

  describe("SQLite type mappings", () => {
    const cases: Array<[string, string]> = [
      ["INTEGER", "int"],
      ["INT", "int"],
      ["BIGINT", "bigint"],
      ["TEXT", "text"],
      ["VARCHAR", "varchar"],
      ["VARCHAR(255)", "varchar"],
      ["DECIMAL(10,2)", "double"],
      ["BLOB", "blob"],
      ["BOOLEAN", "boolean"],
      ["DATETIME", "datetime"],
      ["DATE", "date"],
      ["REAL", "float"],
      ["NUMERIC", "double"],
      ["JSON", "json"],
    ];

    it.each(cases)("should map %s to %s", (dbType, expected) => {
      expect(IntrospectionTypeMapper.toColumnType(dbType, "sqlite")).toBe(expected);
    });

    it("should fall back to varchar for unknown SQLite types", () => {
      expect(IntrospectionTypeMapper.toColumnType("WEIRD_TYPE", "sqlite")).toBe("varchar");
    });

    it("should parse SQLite VARCHAR width", () => {
      expect(IntrospectionTypeMapper.parseSqliteWidth("VARCHAR(120)")).toBe(120);
    });

    it("should return null when there is no SQLite width", () => {
      expect(IntrospectionTypeMapper.parseSqliteWidth("TEXT")).toBeNull();
    });

    it("should parse SQLite precision/scale for DECIMAL", () => {
      expect(IntrospectionTypeMapper.parseSqlitePrecisionScale("DECIMAL(12,3)")).toEqual({
        precision: 12,
        scale: 3,
      });
    });

    it("should not return precision/scale for a single-arg width", () => {
      expect(IntrospectionTypeMapper.parseSqlitePrecisionScale("VARCHAR(255)")).toBeNull();
    });
  });

  describe("MySQL TINYINT width-aware mapping", () => {
    it("should map TINYINT(1) to boolean when full column type is provided", () => {
      expect(IntrospectionTypeMapper.toColumnType("TINYINT", "mysql", "tinyint(1)")).toBe("boolean");
    });

    it("should map TINYINT(4) to int when full column type is provided", () => {
      expect(IntrospectionTypeMapper.toColumnType("TINYINT", "mysql", "tinyint(4)")).toBe("int");
    });

    it("should map TINYINT(3) UNSIGNED to int", () => {
      expect(IntrospectionTypeMapper.toColumnType("TINYINT", "mysql", "tinyint(3) unsigned")).toBe("int");
    });

    it("should fall back to boolean when no full column type is provided", () => {
      expect(IntrospectionTypeMapper.toColumnType("TINYINT", "mysql")).toBe("boolean");
    });
  });

  describe("toTsType()", () => {
    it("should map int to number", () => {
      expect(IntrospectionTypeMapper.toTsType("int")).toBe("number");
    });

    it("should map boolean to boolean", () => {
      expect(IntrospectionTypeMapper.toTsType("boolean")).toBe("boolean");
    });

    it("should map varchar to string", () => {
      expect(IntrospectionTypeMapper.toTsType("varchar")).toBe("string");
    });

    it("should map timestamp to Date", () => {
      expect(IntrospectionTypeMapper.toTsType("timestamp")).toBe("Date");
    });

    it("should map json to any", () => {
      expect(IntrospectionTypeMapper.toTsType("json")).toBe("any");
    });

    it("should map blob to Buffer", () => {
      expect(IntrospectionTypeMapper.toTsType("blob")).toBe("Buffer");
    });
  });
});

// ─── EntityCodeBuilder tests ─────────────────────────────────

describe("EntityCodeBuilder", () => {
  let builder: EntityCodeBuilder;

  beforeEach(() => {
    builder = new EntityCodeBuilder();
  });

  describe("tableNameToClassName()", () => {
    it("should convert snake_case to PascalCase", () => {
      expect(builder.tableNameToClassName("user_profiles")).toBe("UserProfile");
    });

    it("should singularize simple plurals", () => {
      expect(builder.tableNameToClassName("users")).toBe("User");
    });

    it("should handle -ies plurals", () => {
      expect(builder.tableNameToClassName("categories")).toBe("Category");
    });

    it("should handle single-word table", () => {
      expect(builder.tableNameToClassName("post")).toBe("Post");
    });

    it("should not break on double-s endings", () => {
      expect(builder.tableNameToClassName("address")).toBe("Address");
    });
  });

  describe("build() — simple table (non-generated PK)", () => {
    it("should generate entity code with PrimaryColumn for non-generated PK", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "name",
          data_type: "character varying",
          is_nullable: "NO",
          character_maximum_length: 255,
        },
        {
          column_name: "email",
          data_type: "character varying",
          is_nullable: "YES",
          character_maximum_length: 255,
        },
        { column_name: "active", data_type: "boolean", is_nullable: "NO" },
      ];

      const code = builder.build("users", columns, ["id"], [], "postgres");

      // Should contain import with PrimaryColumn (not PrimaryGeneratedColumn)
      expect(code).toContain('import { Column, Entity, PrimaryColumn } from "@stingerloom/orm"');
      // Should contain @Entity with table name
      expect(code).toContain('@Entity({ name: "users" })');
      // Should contain class declaration
      expect(code).toContain("export class User {");
      // Should contain @PrimaryColumn (not @PrimaryGeneratedColumn), with the
      // key's type written out rather than inferred from design:type
      expect(code).toContain('@PrimaryColumn({ type: "int" })');
      expect(code).not.toContain("@PrimaryGeneratedColumn()");
      expect(code).toContain("id!: number;");
      // Should contain @Column with type
      expect(code).toContain('@Column({ type: "varchar", length: 255 })');
      expect(code).toContain("name!: string;");
      // Should detect nullable
      expect(code).toContain('@Column({ type: "varchar", length: 255, nullable: true })');
      expect(code).toContain("email!: string | null;");
      // Should contain boolean column
      expect(code).toContain('@Column({ type: "boolean" })');
      expect(code).toContain("active!: boolean;");
    });
  });

  describe("build() — generated PK (PostgreSQL nextval)", () => {
    it("should use @PrimaryGeneratedColumn when column_default has nextval", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO", column_default: "nextval('users_id_seq'::regclass)" },
        { column_name: "name", data_type: "character varying", is_nullable: "NO", character_maximum_length: 255 },
      ];

      const code = builder.build("users", columns, ["id"], [], "postgres");

      expect(code).toContain("@PrimaryGeneratedColumn()");
      expect(code).not.toContain("@PrimaryColumn()");
      expect(code).toContain('import { Column, Entity, PrimaryGeneratedColumn } from "@stingerloom/orm"');
    });
  });

  describe("build() — generated PK (serial data_type)", () => {
    it("should use @PrimaryGeneratedColumn when data_type is serial", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "serial", is_nullable: "NO" },
      ];

      const code = builder.build("items", columns, ["id"], [], "postgres");

      expect(code).toContain("@PrimaryGeneratedColumn()");
      expect(code).not.toContain("@PrimaryColumn()");
    });
  });

  describe("build() — generated PK (MySQL auto_increment)", () => {
    it("should use @PrimaryGeneratedColumn when extra has auto_increment", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "int", is_nullable: "NO", extra: "auto_increment" },
      ];

      const code = builder.build("items", columns, ["id"], [], "mysql");

      expect(code).toContain("@PrimaryGeneratedColumn()");
      expect(code).not.toContain("@PrimaryColumn()");
    });
  });

  describe("build() — generated PK (PostgreSQL IDENTITY)", () => {
    it("should use @PrimaryGeneratedColumn when is_identity is YES (PG 10+ identity column)", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO", is_identity: "YES" },
      ];

      const code = builder.build("items", columns, ["id"], [], "postgres");

      expect(code).toContain("@PrimaryGeneratedColumn()");
      expect(code).not.toContain("@PrimaryColumn()");
    });
  });

  describe("build() — MySQL TINYINT width awareness", () => {
    it("should emit boolean for TINYINT(1)", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "int", is_nullable: "NO", extra: "auto_increment" },
        { column_name: "active", data_type: "tinyint", column_type: "tinyint(1)", is_nullable: "NO" },
      ];

      const code = builder.build("users", columns, ["id"], [], "mysql");

      expect(code).toContain('@Column({ type: "boolean" })');
      expect(code).toContain("active!: boolean;");
    });

    it("should emit int for TINYINT(4)", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "int", is_nullable: "NO", extra: "auto_increment" },
        { column_name: "rank", data_type: "tinyint", column_type: "tinyint(4)", is_nullable: "NO" },
      ];

      const code = builder.build("users", columns, ["id"], [], "mysql");

      expect(code).toContain('@Column({ type: "int" })');
      expect(code).toContain("rank!: number;");
      expect(code).not.toContain("rank!: boolean;");
    });
  });

  describe("build() — default value preservation", () => {
    it("should emit string literal default", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "status",
          data_type: "character varying",
          is_nullable: "NO",
          character_maximum_length: 32,
          column_default: "'active'",
        },
      ];

      const code = builder.build("orders", columns, ["id"], [], "postgres");

      expect(code).toContain('default: "active"');
    });

    it("should strip PostgreSQL type cast from string default", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "status",
          data_type: "character varying",
          is_nullable: "NO",
          character_maximum_length: 32,
          column_default: "'active'::character varying",
        },
      ];

      const code = builder.build("orders", columns, ["id"], [], "postgres");

      expect(code).toContain('default: "active"');
      expect(code).not.toContain("::character varying");
    });

    it("should emit numeric default literally for int columns", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "retry_count",
          data_type: "integer",
          is_nullable: "NO",
          column_default: "0",
        },
      ];

      const code = builder.build("jobs", columns, ["id"], [], "postgres");

      expect(code).toContain("default: 0");
    });

    it("should emit boolean default when column is boolean", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "active",
          data_type: "boolean",
          is_nullable: "NO",
          column_default: "true",
        },
      ];

      const code = builder.build("users", columns, ["id"], [], "postgres");

      expect(code).toContain("default: true");
    });

    it("should wrap raw SQL expression defaults in parentheses (CURRENT_TIMESTAMP)", () => {
      // Note: column name is intentionally NOT created_at/updated_at so the
      // timestamp-decorator heuristic doesn't kick in and we exercise the
      // raw default preservation path.
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "occurred_at",
          data_type: "timestamp",
          is_nullable: "NO",
          column_default: "CURRENT_TIMESTAMP",
        },
      ];

      const code = builder.build("events", columns, ["id"], [], "postgres");

      expect(code).toContain('default: "(CURRENT_TIMESTAMP)"');
    });

    it("should skip a bare 'NULL' default (MariaDB INFORMATION_SCHEMA quirk)", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "nickname",
          data_type: "varchar",
          is_nullable: "YES",
          character_maximum_length: 64,
          column_default: "NULL",
        },
      ];
      const code = builder.build("users", columns, ["id"], [], "mysql");

      expect(code).not.toContain('default: "(NULL)"');
      expect(code).not.toContain("default:");
      expect(code).toContain('@Column({ type: "varchar", length: 64, nullable: true })');
    });

    it("should skip nextval() PK defaults (handled by @PrimaryGeneratedColumn)", () => {
      const columns: DbColumn[] = [
        {
          column_name: "id",
          data_type: "integer",
          is_nullable: "NO",
          column_default: "nextval('items_id_seq'::regclass)",
        },
      ];

      const code = builder.build("items", columns, ["id"], [], "postgres");

      expect(code).not.toContain("default:");
      expect(code).toContain("@PrimaryGeneratedColumn()");
    });
  });

  describe("build() — char length & decimal precision/scale", () => {
    it("should preserve char length for CHAR columns", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "code",
          data_type: "character",
          is_nullable: "NO",
          character_maximum_length: 4,
        },
      ];

      const code = builder.build("countries", columns, ["id"], [], "postgres");

      expect(code).toContain('@Column({ type: "char", length: 4 })');
    });

    it("should preserve precision and scale for numeric/decimal columns", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "amount",
          data_type: "numeric",
          is_nullable: "NO",
          numeric_precision: 12,
          numeric_scale: 2,
        },
      ];

      const code = builder.build("payments", columns, ["id"], [], "postgres");

      expect(code).toContain('@Column({ type: "double", precision: 12, scale: 2 })');
    });
  });

  describe("build() — FK generates @ManyToOne", () => {
    it("should produce @ManyToOne + @RelationColumn pair and import for FK columns", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "title", data_type: "varchar", is_nullable: "NO", character_maximum_length: 255 },
        { column_name: "author_id", data_type: "integer", is_nullable: "NO" },
      ];

      const fks: DbForeignKey[] = [
        {
          column_name: "author_id",
          referenced_table: "users",
          referenced_column: "id",
        },
      ];

      const code = builder.build("posts", columns, ["id"], fks, "mysql");

      // Should contain ManyToOne + RelationColumn imports
      expect(code).toContain("ManyToOne");
      expect(code).toContain("RelationColumn");
      // Should NOT contain author_id as a plain @Column
      expect(code).not.toMatch(/@Column\([^)]*\)\s*\n\s*authorId/);
      // Should emit @ManyToOne without the deprecated joinColumn option
      expect(code).toContain("@ManyToOne(() => User, (entity: any) => entity.author)");
      expect(code).not.toContain("joinColumn:");
      // FK column declared via @RelationColumn
      expect(code).toContain(
        '@RelationColumn({ name: "author_id", type: "int", nullable: false, referencedColumn: "id" })',
      );
      expect(code).toContain("author!: Relation<User>;");
      // Should contain import for referenced User class
      expect(code).toContain('import { User } from "./user.entity.js";');
      // Relation<> wrapper is imported with the inline `type` modifier
      expect(code).toContain("type Relation }");
      // Should contain @Entity with table name
      expect(code).toContain('@Entity({ name: "posts" })');
    });
  });

  describe("build() — round-trip name: preservation", () => {
    it("should emit @Column name: option when DB column name differs from camelCase property", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "access_key", data_type: "varchar", is_nullable: "NO", character_maximum_length: 191 },
      ];
      const code = builder.build("api_key", columns, ["id"], [], "mysql");

      expect(code).toContain('@Column({ type: "varchar", name: "access_key", length: 191 })');
      expect(code).toContain("accessKey!: string;");
    });

    it("should emit @PrimaryGeneratedColumn name: option for non-camelCase PK", () => {
      const columns: DbColumn[] = [
        { column_name: "CTGR_SQ", data_type: "integer", is_nullable: "NO", extra: "auto_increment" },
      ];
      const code = builder.build("category", columns, ["CTGR_SQ"], [], "mysql");

      expect(code).toContain('@PrimaryGeneratedColumn({ name: "CTGR_SQ" })');
      expect(code).toContain("ctgrSq!: number;");
    });

    it("should NOT emit name: option when column already matches camelCase", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "username", data_type: "varchar", is_nullable: "NO", character_maximum_length: 255 },
      ];
      const code = builder.build("users", columns, ["id"], [], "mysql");

      expect(code).toContain('@Column({ type: "varchar", length: 255 })');
      expect(code).not.toContain('name: "username"');
    });
  });

  describe("build() — timestamp decorators", () => {
    it("should emit @CreateTimestamp for created_at (timestamp, not nullable) and propagate name", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "created_at",
          data_type: "timestamp",
          is_nullable: "NO",
          column_default: "CURRENT_TIMESTAMP",
        },
      ];
      const code = builder.build("events", columns, ["id"], [], "postgres");

      // A wall-clock timestamp is `datetime`, the decorator's default type
      // (TIMESTAMP on PostgreSQL either way).
      expect(code).toContain('@CreateTimestamp({ name: "created_at" })');
      expect(code).toContain("createdAt!: Date;");
      expect(code).not.toContain("default:");
      // The database default the marker replaces is not dropped silently.
      expect(code).toContain(
        "// NOTE: DEFAULT CURRENT_TIMESTAMP is not declared: as a create timestamp the column is filled in by the ORM instead.",
      );
    });

    it("should emit @UpdateTimestamp for updated_at with name option", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "updated_at", data_type: "datetime", is_nullable: "NO" },
      ];
      const code = builder.build("events", columns, ["id"], [], "mysql");

      // datetime is the default type so only `name` is included
      expect(code).toContain('@UpdateTimestamp({ name: "updated_at" })');
      expect(code).toContain("updatedAt!: Date;");
    });

    it("should emit bare @UpdateTimestamp() when the column already matches camelCase", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "updatedAt", data_type: "datetime", is_nullable: "NO" },
      ];
      const code = builder.build("events", columns, ["id"], [], "mysql");

      expect(code).toContain("@UpdateTimestamp()");
      expect(code).not.toContain('name: "updatedAt"');
    });

    it("should emit @DeletedAt for nullable deleted_at", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "deleted_at",
          data_type: "timestamptz",
          is_nullable: "YES",
        },
      ];
      const code = builder.build("users", columns, ["id"], [], "postgres");

      expect(code).toContain(
        '@DeletedAt({ type: "timestamptz", name: "deleted_at" })',
      );
      expect(code).toContain("deletedAt!: Date | null;");
    });

    it("should NOT treat nullable created_at as @CreateTimestamp", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "created_at", data_type: "timestamp", is_nullable: "YES" },
      ];
      const code = builder.build("events", columns, ["id"], [], "postgres");

      expect(code).not.toContain("@CreateTimestamp");
      expect(code).toContain('@Column({ type: "datetime", name: "created_at", nullable: true })');
    });
  });

  describe("build() — indexes", () => {
    it("should emit property-level @Index for a single-column non-unique index", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "email", data_type: "varchar", is_nullable: "NO", character_maximum_length: 255 },
      ];
      const indexes: DbIndex[] = [
        { name: "idx_users_email", column_names: ["email"], is_unique: false },
      ];
      const code = builder.build("users", columns, ["id"], [], "postgres", indexes);

      expect(code).toContain("@Index()");
      expect(code).toContain("email!: string;");
      expect(code).toContain("Index");
    });

    it("should emit class-level @UniqueIndex for a single-column unique index", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "email", data_type: "varchar", is_nullable: "NO", character_maximum_length: 255 },
      ];
      const indexes: DbIndex[] = [
        { name: "uq_users_email", column_names: ["email"], is_unique: true },
      ];
      const code = builder.build("users", columns, ["id"], [], "postgres", indexes);

      expect(code).toContain('@UniqueIndex(["email"], "uq_users_email")');
      expect(code).toContain("UniqueIndex");
    });

    it("should drop reserved sqlite_autoindex_* names so the index can be re-applied", () => {
      // SQLite reports implicit UNIQUE-constraint indexes under reserved
      // names; emitting them verbatim makes schema sync fail with
      // "object name reserved for internal use" and silently lose the index.
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "email", data_type: "varchar", is_nullable: "NO", character_maximum_length: 255 },
      ];
      const indexes: DbIndex[] = [
        { name: "sqlite_autoindex_users_1", column_names: ["email"], is_unique: true },
      ];
      const code = builder.build("users", columns, ["id"], [], "sqlite", indexes);

      expect(code).toContain('@UniqueIndex(["email"])');
      expect(code).not.toContain("sqlite_autoindex");
    });

    it("should emit class-level @Index for a multi-column non-unique index", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "tenant_id", data_type: "integer", is_nullable: "NO" },
        { column_name: "status", data_type: "varchar", is_nullable: "NO", character_maximum_length: 32 },
      ];
      const indexes: DbIndex[] = [
        { name: "idx_orders_tenant_status", column_names: ["tenant_id", "status"], is_unique: false },
      ];
      const code = builder.build("orders", columns, ["id"], [], "postgres", indexes);

      // Class-level decorators must reference property keys (not DB
       // column names); the ORM maps them back via metadata.
      expect(code).toContain(
        '@Index(["tenantId", "status"], "idx_orders_tenant_status")',
      );
    });

    it("should skip indexes that exactly cover the primary key", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
      ];
      const indexes: DbIndex[] = [
        { name: "pk_users", column_names: ["id"], is_unique: true },
      ];
      const code = builder.build("users", columns, ["id"], [], "postgres", indexes);

      expect(code).not.toContain("UniqueIndex");
      expect(code).not.toContain("@Index");
    });
  });

  describe("build() — composite-PK closure table (FK columns ARE the PK)", () => {
    it("should emit @PrimaryColumn for FK columns that are also PKs, plus a relation", () => {
      const columns: DbColumn[] = [
        { column_name: "id_ancestor", data_type: "int", is_nullable: "NO" },
        { column_name: "id_descendant", data_type: "int", is_nullable: "NO" },
      ];
      const fks: DbForeignKey[] = [
        { column_name: "id_ancestor", referenced_table: "post_comment", referenced_column: "id" },
        { column_name: "id_descendant", referenced_table: "post_comment", referenced_column: "id" },
      ];

      const code = builder.build(
        "post_comment_closure",
        columns,
        ["id_ancestor", "id_descendant"],
        fks,
        "mysql",
      );

      // Both FK-PK columns must have @PrimaryColumn declarations
      expect(code).toContain('@PrimaryColumn({ type: "int", name: "id_ancestor" })');
      expect(code).toContain("idAncestor!: number;");
      expect(code).toContain('@PrimaryColumn({ type: "int", name: "id_descendant" })');
      expect(code).toContain("idDescendant!: number;");

      // And the FK relation properties (with `id_` prefix stripped → ancestor/descendant)
      expect(code).toContain(
        '@RelationColumn({ name: "id_ancestor", type: "int", nullable: false, referencedColumn: "id" })',
      );
      expect(code).toContain("ancestor!: Relation<PostComment>;");
      expect(code).toContain(
        '@RelationColumn({ name: "id_descendant", type: "int", nullable: false, referencedColumn: "id" })',
      );
      expect(code).toContain("descendant!: Relation<PostComment>;");
    });
  });

  describe("fkToPropertyName — id_ prefix stripping", () => {
    it("should strip an id_ prefix when there is no _id suffix", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "int", is_nullable: "NO" },
        { column_name: "id_parent", data_type: "int", is_nullable: "YES" },
      ];
      const fks: DbForeignKey[] = [
        { column_name: "id_parent", referenced_table: "node", referenced_column: "id" },
      ];
      const code = builder.build("node", columns, ["id"], fks, "postgres");

      expect(code).toContain("parent!: Relation<Node>;");
    });
  });

  describe("build() — self-referential FK", () => {
    it("should NOT emit an import for the class itself when a FK points back to the same table", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "name", data_type: "varchar", is_nullable: "NO", character_maximum_length: 64 },
        { column_name: "parent_id", data_type: "integer", is_nullable: "YES" },
      ];
      const fks: DbForeignKey[] = [
        { column_name: "parent_id", referenced_table: "department", referenced_column: "id" },
      ];

      const code = builder.build("department", columns, ["id"], fks, "postgres");

      // The class is Department; we must NOT see `import { Department }` lines.
      expect(code).not.toMatch(/import\s*\{\s*Department\s*\}\s*from/);
      // But the FK relation should still resolve to Department.
      expect(code).toContain("@ManyToOne(() => Department, (entity: any) => entity.parent)");
      expect(code).toContain(
        '@RelationColumn({ name: "parent_id", type: "int", nullable: true, referencedColumn: "id" })',
      );
    });
  });

  describe("build() — FK property collision", () => {
    it("should fall back to camelCased FK column name when stripped name collides with a plain column", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "user", data_type: "text", is_nullable: "NO" },
        { column_name: "user_id", data_type: "integer", is_nullable: "NO" },
      ];
      const fks: DbForeignKey[] = [
        { column_name: "user_id", referenced_table: "users", referenced_column: "id" },
      ];

      const code = builder.build("audit_log", columns, ["id"], fks, "postgres");

      // FK property must not collide with the `user` text column
      expect(code).toContain("userId!: Relation<User>;");
      expect(code).toContain(
        '@RelationColumn({ name: "user_id", type: "int", nullable: false, referencedColumn: "id" })',
      );
      expect(code).toContain("user!: string;");
    });

    it("should disambiguate FK whose stripped name collides with another plain column", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "author_id", data_type: "integer", is_nullable: "NO" },
        { column_name: "author", data_type: "text", is_nullable: "NO" },
      ];
      const fks: DbForeignKey[] = [
        { column_name: "author_id", referenced_table: "users", referenced_column: "id" },
      ];

      const code = builder.build("posts", columns, ["id"], fks, "postgres");

      // Plain text column "author" stays, FK relation becomes authorId
      expect(code).toContain("author!: string;");
      expect(code).toContain("authorId!: Relation<User>;");
    });
  });

  describe("build() — ENUM column", () => {
    it("should detect PostgreSQL USER-DEFINED as enum", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "status", data_type: "USER-DEFINED", is_nullable: "NO" },
      ];

      const code = builder.build("orders", columns, ["id"], [], "postgres");

      expect(code).toContain('@Column({ type: "enum" })');
      expect(code).toContain("status!: string;");
      expect(code).toContain('@Entity({ name: "orders" })');
    });

    it("should detect MySQL ENUM type", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "int", is_nullable: "NO" },
        { column_name: "role", data_type: "enum", is_nullable: "NO" },
      ];

      const code = builder.build("users", columns, ["id"], [], "mysql");

      expect(code).toContain('@Column({ type: "enum" })');
      expect(code).toContain('@Entity({ name: "users" })');
    });

    it("should embed PostgreSQL enum labels when provided", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        {
          column_name: "status",
          data_type: "USER-DEFINED",
          is_nullable: "NO",
          enum_values: ["pending", "active", "archived"],
        },
      ];

      const code = builder.build("orders", columns, ["id"], [], "postgres");

      expect(code).toContain(
        '@Column({ type: "enum", enumValues: ["pending", "active", "archived"] })',
      );
    });

    it("should embed MySQL enum labels when provided", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "int", is_nullable: "NO" },
        {
          column_name: "role",
          data_type: "enum",
          column_type: "enum('admin','user','guest')",
          is_nullable: "NO",
          enum_values: ["admin", "user", "guest"],
        },
      ];

      const code = builder.build("users", columns, ["id"], [], "mysql");

      expect(code).toContain(
        '@Column({ type: "enum", enumValues: ["admin", "user", "guest"] })',
      );
    });
  });

  describe("build() — custom import path", () => {
    it("should use custom import path", () => {
      const customBuilder = new EntityCodeBuilder({
        importPath: "stingerloom-orm",
      });

      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
      ];

      const code = customBuilder.build("tests", columns, ["id"], [], "postgres");

      expect(code).toContain('from "stingerloom-orm"');
    });
  });
});

// ─── IntrospectionGenerator tests ────────────────────────────
//
// The generator runs the catalog reader, the lowering and an emitter. These
// drive it through fake catalogs answering the readers' statements; the
// statements themselves are pinned in introspection-catalog.test.ts.

type Row = Record<string, unknown>;

interface FakeTable {
  columns: Row[];
  pk?: string[];
  fks?: Row[];
  indexes?: Row[];
}

function queryText(q: any): { text: string; values: unknown[] } {
  return typeof q === "string" ? { text: q, values: [] } : { text: q.sql, values: q.values };
}

/** A PostgreSQL catalog: columns as `format_type` rows. */
function pgCatalog(tables: Record<string, FakeTable>) {
  return jest.fn(async (q: any) => {
    const { text, values } = queryText(q);
    const table = tables[values[1] as string];
    if (text.includes("relkind IN")) return Object.keys(tables).sort().map((t) => ({ table_name: t }));
    if (!table) return [];
    if (text.includes("format_type")) return table.columns;
    if (text.includes("indisprimary ORDER BY k.ord")) return (table.pk ?? []).map((c) => ({ column_name: c }));
    if (text.includes("contype = 'f'")) return table.fks ?? [];
    if (text.includes("pg_am")) return table.indexes ?? [];
    return [];
  });
}

const pgCol = (name: string, type: string, extra: Row = {}): Row => ({
  column_name: name,
  type_text: type,
  not_null: true,
  default_expr: null,
  type_name: type,
  type_kind: "b",
  is_identity: "NO",
  is_generated: "NEVER",
  ...extra,
});

const pgFk = (name: string, column: string, table: string, refColumn = "id", extra: Row = {}): Row => ({
  constraint_name: name,
  column_name: column,
  referenced_schema: "public",
  referenced_table: table,
  referenced_column: refColumn,
  update_action: "a",
  delete_action: "a",
  ...extra,
});

describe("IntrospectionGenerator", () => {
  const blog = (): Record<string, FakeTable> => ({
    users: {
      columns: [
        pgCol("id", "integer", { is_identity: "YES" }),
        pgCol("name", "character varying(255)"),
      ],
      pk: ["id"],
    },
    posts: {
      columns: [
        pgCol("id", "integer", { is_identity: "YES" }),
        pgCol("title", "character varying(255)"),
        pgCol("author_id", "integer"),
      ],
      pk: ["id"],
      fks: [pgFk("posts_author_id_fkey", "author_id", "users", "id", { delete_action: "c" })],
    },
  });

  describe("generate()", () => {
    it("generates an entity per table, relations included", async () => {
      const generator = new IntrospectionGenerator(pgCatalog(blog()), "postgres");
      const results = await generator.generate();

      expect(results.map((r) => [r.tableName, r.className, r.fileName])).toEqual([
        ["posts", "Post", "post.entity.ts"],
        ["users", "User", "user.entity.ts"],
      ]);
      const post = results[0];
      expect(post.code).toContain('import { User } from "./user.entity.js";');
      expect(post.code).toContain(
        '@ManyToOne(() => User, (entity: any) => entity.author, { onDelete: "CASCADE" })',
      );
      expect(post.code).toContain(
        '@RelationColumn({ name: "author_id", type: "int", nullable: false, referencedColumn: "id" })',
      );
      expect(results.every((r) => r.notes.length === 0)).toBe(true);
    });

    it("skips tables in excludeTables", async () => {
      const tables = blog();
      tables.__migrations = { columns: [pgCol("id", "integer")], pk: ["id"] };
      const generator = new IntrospectionGenerator(pgCatalog(tables), "postgres", {
        excludeTables: ["__migrations"],
      });
      expect((await generator.generate()).map((r) => r.tableName)).toEqual(["posts", "users"]);
    });

    it("keeps a foreign key to a table that is not generated as a plain column", async () => {
      const generator = new IntrospectionGenerator(pgCatalog(blog()), "postgres", {
        includeTables: ["posts"],
      });
      const [post] = await generator.generate();

      // A relation would import a class that is never generated.
      expect(post.code).not.toContain("import { User }");
      expect(post.code).toContain('@Column({ type: "int", name: "author_id" })');
      expect(post.notes).toEqual([
        'Foreign key (author_id) → users(id) is not declared as a relation: "users" is not among the generated tables. The column is kept as a plain column.',
      ]);
      expect(post.code).toContain(`// NOTE: ${post.notes[0]}`);
    });

    it("gives every table a distinct, declarable class name", async () => {
      const generator = new IntrospectionGenerator(
        pgCatalog({
          user: { columns: [pgCol("id", "integer")], pk: ["id"] },
          users: { columns: [pgCol("id", "integer")], pk: ["id"] },
          errors: { columns: [pgCol("id", "integer")], pk: ["id"] },
          "2024_sales": { columns: [pgCol("id", "integer")], pk: ["id"] },
        }),
        "postgres",
      );
      const names = (await generator.generate()).map((r) => [r.tableName, r.className, r.fileName]);
      expect(names).toEqual([
        ["2024_sales", "Table2024Sale", "table2024sale.entity.ts"],
        ["errors", "ErrorEntity", "error-entity.entity.ts"],
        ["user", "User", "user.entity.ts"],
        ["users", "Users", "users.entity.ts"],
      ]);
    });

    it("turns any column name into a valid, unique property", async () => {
      const generator = new IntrospectionGenerator(
        pgCatalog({
          orders: {
            columns: [
              pgCol("id", "integer"),
              pgCol("order-ref", "text"),
              pgCol("user_name", "text"),
              pgCol("userName", "text"),
              pgCol("constructor", "text"),
              pgCol("2fa_code", "text"),
              pgCol('say "hi"', "text"),
            ],
            pk: ["id"],
          },
        }),
        "postgres",
      );
      const [order] = await generator.generate();
      expect(order.code).toContain('@Column({ type: "text", name: "order-ref" })\n  orderRef!: string;');
      expect(order.code).toContain('@Column({ type: "text", name: "user_name" })\n  userName!: string;');
      expect(order.code).toContain('@Column({ type: "text", name: "userName" })\n  userName2!: string;');
      expect(order.code).toContain('@Column({ type: "text", name: "constructor" })\n  constructor_!: string;');
      expect(order.code).toContain('@Column({ type: "text", name: "2fa_code" })\n  _2faCode!: string;');
      expect(order.code).toContain('@Column({ type: "text", name: "say \\"hi\\"" })\n  sayHi!: string;');
    });

    it("reports a composite foreign key and an index it cannot declare", async () => {
      const generator = new IntrospectionGenerator(
        pgCatalog({
          memberships: {
            columns: [pgCol("org_id", "integer"), pgCol("user_id", "integer")],
            pk: ["org_id", "user_id"],
          },
          grants: {
            columns: [pgCol("id", "integer"), pgCol("org_id", "integer"), pgCol("user_id", "integer")],
            pk: ["id"],
            fks: [
              pgFk("fk_member", "org_id", "memberships", "org_id"),
              pgFk("fk_member", "user_id", "memberships", "user_id"),
            ],
            indexes: [
              { index_name: "idx_live", is_unique: false, method: "btree", predicate: "(org_id > 0)", definition: "", column_name: "org_id", quoted_name: "org_id", part_definition: "org_id" },
            ],
          },
        }),
        "postgres",
      );
      const grant = (await generator.generate()).find((r) => r.tableName === "grants")!;
      expect(grant.code).not.toContain("@ManyToOne");
      expect(grant.notes).toEqual([
        "Composite foreign key (org_id, user_id) → memberships(org_id, user_id) is not declared: a relation joins on a single column. Its columns are kept as plain columns; recreate the constraint in a migration.",
        'Index "idx_live" is not declared: partial index WHERE (org_id > 0) cannot be expressed with the ORM\'s index options. Recreate it in a migration.',
      ]);
    });

    it("keeps a PostgreSQL enum's type name and an array's element type", async () => {
      const generator = new IntrospectionGenerator(
        pgCatalog({
          orders: {
            columns: [
              pgCol("id", "integer"),
              pgCol("status", "order_status", {
                type_name: "order_status",
                type_kind: "e",
                enum_labels: ["pending", "paid"],
                default_expr: "'pending'::order_status",
              }),
              pgCol("scores", "integer[]"),
            ],
            pk: ["id"],
          },
        }),
        "postgres",
      );
      const [order] = await generator.generate();
      expect(order.code).toContain(
        '@Column({ type: "enum", enumValues: ["pending", "paid"], enumName: "order_status", default: "pending" })',
      );
      expect(order.code).toContain('@Column({ type: "array", arrayElementType: "int", nullable: false })');
    });

    it("writes each lossy mapping into the file", async () => {
      const generator = new IntrospectionGenerator(
        pgCatalog({
          readings: {
            columns: [
              pgCol("id", "integer"),
              pgCol("value", "double precision"),
              pgCol("peer", "inet", { not_null: false }),
            ],
            pk: ["id"],
          },
        }),
        "postgres",
      );
      const [reading] = await generator.generate();
      expect(reading.notes).toEqual([
        'value: The database declares "double precision", but this entity creates "REAL" — synchronizing it would change the column.',
        'peer: No ORM column type matches "inet" — mapped to "text", which is created as "TEXT". Synchronizing this entity will NOT recreate the original type; register a custom column type or edit this column by hand.',
      ]);
    });
  });

  describe("MySQL", () => {
    function mysqlCatalog(version: string) {
      return jest.fn(async (q: any) => {
        const { text } = queryText(q);
        if (text.includes("SELECT VERSION()")) return [{ version }];
        if (text.includes("information_schema.TABLES")) return [{ table_name: "posts" }];
        if (text.includes("information_schema.COLUMNS")) {
          return [
            { COLUMN_NAME: "id", COLUMN_TYPE: "int", IS_NULLABLE: "NO", COLUMN_DEFAULT: null, EXTRA: "auto_increment" },
            { COLUMN_NAME: "status", COLUMN_TYPE: "enum('draft','it''s')", IS_NULLABLE: "NO", COLUMN_DEFAULT: "draft", EXTRA: "" },
            { COLUMN_NAME: "views", COLUMN_TYPE: "int unsigned", IS_NULLABLE: "NO", COLUMN_DEFAULT: "0", EXTRA: "" },
            { COLUMN_NAME: "is_public", COLUMN_TYPE: "tinyint(1)", IS_NULLABLE: "NO", COLUMN_DEFAULT: "1", EXTRA: "" },
          ];
        }
        if (text.includes("CONSTRAINT_NAME = 'PRIMARY'")) return [{ column_name: "id" }];
        return [];
      });
    }

    it("generates from MySQL's catalog, bare literal defaults included", async () => {
      const [post] = await new IntrospectionGenerator(mysqlCatalog("8.0.36"), "mysql").generate();

      expect(post.code).toContain("@PrimaryGeneratedColumn()");
      expect(post.code).toContain(
        '@Column({ type: "enum", enumValues: ["draft", "it\'s"], default: "draft" })',
      );
      expect(post.code).toContain('@Column({ type: "boolean", name: "is_public", default: true })');
      expect(post.notes).toEqual([
        'views: The database declares "int unsigned", but this entity creates "INT" — synchronizing it would change the column.',
      ]);
    });
  });

  describe("SQLite", () => {
    function sqliteCatalog() {
      return jest.fn(async (q: any) => {
        const { text } = queryText(q);
        if (text.includes("name NOT LIKE 'sqlite_%'")) return [{ table_name: "comments" }, { table_name: "posts" }];
        if (text.includes("SELECT sql FROM sqlite_master")) return [{ sql: "CREATE TABLE t (…)" }];
        if (text === 'PRAGMA table_xinfo("posts")') {
          return [
            { cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
            { cid: 1, name: "title", type: "VARCHAR(200)", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
          ];
        }
        if (text === 'PRAGMA table_xinfo("comments")') {
          return [
            { cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
            { cid: 1, name: "post_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
            { cid: 2, name: "parent_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
          ];
        }
        if (text === 'PRAGMA foreign_key_list("comments")') {
          return [
            { id: 0, seq: 0, table: "posts", from: "post_id", to: "id", on_update: "NO ACTION", on_delete: "CASCADE" },
            { id: 1, seq: 0, table: "comments", from: "parent_id", to: "id", on_update: "NO ACTION", on_delete: "NO ACTION" },
          ];
        }
        if (text === 'PRAGMA index_list("comments")') {
          return [{ seq: 0, name: "idx_comments_post", unique: 0, origin: "c", partial: 0 }];
        }
        if (text === 'PRAGMA index_xinfo("idx_comments_post")') {
          return [{ seqno: 0, cid: 1, name: "post_id", desc: 0, coll: "BINARY", key: 1 }];
        }
        return [];
      });
    }

    it("generates the rowid alias as a generated key and foreign keys as relations", async () => {
      const results = await new IntrospectionGenerator(sqliteCatalog(), "sqlite").generate();
      const comment = results.find((r) => r.tableName === "comments")!;

      expect(comment.code).toContain("@PrimaryGeneratedColumn()");
      expect(comment.code).toContain(
        '@ManyToOne(() => Post, (entity: any) => entity.post, { onDelete: "CASCADE" })',
      );
      // Self reference: no import of its own class.
      expect(comment.code).toContain("@ManyToOne(() => Comment, (entity: any) => entity.parent)");
      expect(comment.code).not.toContain('import { Comment }');
      // SQLite does not index a foreign key by itself, so this index is the
      // schema's own and is kept — on the join column's name.
      expect(comment.code).toContain('@Index(["post_id"], "idx_comments_post")');
    });

    it("rejects a table name that cannot be escaped into a PRAGMA", async () => {
      const generator = new IntrospectionGenerator(jest.fn(async () => []), "sqlite");
      await expect(generator.getColumns("bad\u0000name")).rejects.toThrow(/NUL/);
    });
  });

  describe("readSchema()", () => {
    it("returns the selected tables as the schema IR", async () => {
      const generator = new IntrospectionGenerator(pgCatalog(blog()), "postgres", {
        schema: "public",
        includeTables: ["users"],
      });
      const ir = await generator.readSchema();
      expect(ir).toEqual({
        dialect: "postgres",
        schema: "public",
        tables: [
          {
            name: "users",
            columns: [
              { name: "id", type: { kind: "integer", bytes: 4, unsigned: false }, nullable: false, identity: true, nativeType: "integer", rawDefault: null },
              { name: "name", type: { kind: "string", fixed: false, length: 255 }, nullable: false, identity: false, nativeType: "character varying(255)", rawDefault: null },
            ],
            primaryKey: ["id"],
            foreignKeys: [],
            indexes: [],
          },
        ],
      });
    });
  });

  describe("deprecated row accessors", () => {
    const tables = (): Record<string, FakeTable> => ({
      grants: {
        columns: [
          pgCol("id", "integer", { is_identity: "YES" }),
          pgCol("org_id", "integer"),
          pgCol("user_id", "integer"),
          pgCol("note", "character varying(100)", { not_null: false, default_expr: "'x'::character varying" }),
        ],
        pk: ["id"],
        fks: [
          pgFk("fk_member", "org_id", "memberships", "org_id"),
          pgFk("fk_member", "user_id", "memberships", "user_id"),
          pgFk("fk_org", "org_id", "orgs"),
        ],
        indexes: [
          { index_name: "idx_org", is_unique: false, method: "btree", predicate: null, definition: "", column_name: "org_id", quoted_name: "org_id", part_definition: "org_id" },
          { index_name: "uq_note", is_unique: true, method: "btree", predicate: null, definition: "", column_name: "note", quoted_name: "note", part_definition: "note" },
        ],
      },
    });
    const generator = () => new IntrospectionGenerator(pgCatalog(tables()), "postgres");

    it("getColumns() keeps the row shape", async () => {
      const columns = await generator().getColumns("grants");
      expect(columns[0]).toMatchObject({ column_name: "id", data_type: "integer", is_nullable: "NO", is_identity: "YES" });
      expect(columns[3]).toMatchObject({
        column_name: "note",
        data_type: "character varying",
        character_maximum_length: 100,
        is_nullable: "YES",
        column_default: "'x'::character varying",
      });
    });

    it("getPrimaryKeys() / getForeignKeys() / getIndexes()", async () => {
      expect(await generator().getPrimaryKeys("grants")).toEqual(["id"]);
      expect(await generator().getForeignKeys("grants")).toEqual([
        { column_name: "org_id", referenced_table: "memberships", referenced_column: "org_id", constraint_name: "fk_member" },
        { column_name: "user_id", referenced_table: "memberships", referenced_column: "user_id", constraint_name: "fk_member" },
        { column_name: "org_id", referenced_table: "orgs", referenced_column: "id", constraint_name: "fk_org" },
      ]);
      // A single-column index on a foreign key column is left out.
      expect(await generator().getIndexes("grants")).toEqual([
        { name: "uq_note", column_names: ["note"], is_unique: true },
      ]);
    });
  });
});
