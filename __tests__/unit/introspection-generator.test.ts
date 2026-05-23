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
      // Should contain @PrimaryColumn (not @PrimaryGeneratedColumn)
      expect(code).toContain("@PrimaryColumn()");
      expect(code).not.toContain("@PrimaryGeneratedColumn()");
      expect(code).toContain("id!: number;");
      // Should contain @Column with type
      expect(code).toContain('@Column({ type: "varchar", length: 255 })');
      expect(code).toContain("name!: string;");
      // Should detect nullable
      expect(code).toContain('@Column({ type: "varchar", length: 255, nullable: true })');
      expect(code).toContain("email!: string;");
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
      expect(code).toContain('@RelationColumn({ name: "author_id" })');
      expect(code).toContain("author!: User;");
      // Should contain import for referenced User class
      expect(code).toContain('import { User } from "./user.entity";');
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

      expect(code).toContain('@CreateTimestamp({ type: "timestamp", name: "created_at" })');
      expect(code).toContain("createdAt!: Date;");
      expect(code).not.toContain("default:");
      expect(code).toContain("CreateTimestamp");
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
      expect(code).toContain("deletedAt!: Date;");
    });

    it("should NOT treat nullable created_at as @CreateTimestamp", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "created_at", data_type: "timestamp", is_nullable: "YES" },
      ];
      const code = builder.build("events", columns, ["id"], [], "postgres");

      expect(code).not.toContain("@CreateTimestamp");
      expect(code).toContain('@Column({ type: "timestamp", name: "created_at", nullable: true })');
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
      expect(code).toContain('@RelationColumn({ name: "id_ancestor" })');
      expect(code).toContain("ancestor!: PostComment;");
      expect(code).toContain('@RelationColumn({ name: "id_descendant" })');
      expect(code).toContain("descendant!: PostComment;");
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

      expect(code).toContain("parent!: Node;");
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
      expect(code).toContain('@RelationColumn({ name: "parent_id" })');
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
      expect(code).toContain("userId!: User;");
      expect(code).toContain('@RelationColumn({ name: "user_id" })');
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
      expect(code).toContain("authorId!: User;");
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
        '@Column({ type: "enum", enum: ["pending", "active", "archived"] })',
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
        '@Column({ type: "enum", enum: ["admin", "user", "guest"] })',
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

describe("IntrospectionGenerator", () => {
  describe("generate()", () => {
    it("should generate entity for each discovered table", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        // discoverTables
        if (sqlText.includes("pg_tables") || sqlText.includes("information_schema.TABLES")) {
          return [
            { table_name: "users" },
            { table_name: "posts" },
          ];
        }

        // getColumns for users
        if (sqlText.includes("information_schema") && sqlText.includes("columns")) {
          const values = sqlInput.values ?? [];
          if (values.includes("users")) {
            return [
              { column_name: "id", data_type: "integer", is_nullable: "NO" },
              { column_name: "name", data_type: "character varying", is_nullable: "NO", character_maximum_length: 255 },
            ];
          }
          if (values.includes("posts")) {
            return [
              { column_name: "id", data_type: "integer", is_nullable: "NO" },
              { column_name: "title", data_type: "character varying", is_nullable: "NO", character_maximum_length: 255 },
            ];
          }
        }

        // getPrimaryKeys
        if (sqlText.includes("pg_index") || sqlText.includes("KEY_COLUMN_USAGE")) {
          return [{ column_name: "id" }];
        }

        // getForeignKeys
        if (sqlText.includes("FOREIGN KEY") || sqlText.includes("constraint_type")) {
          return [];
        }

        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "postgres");
      const results = await generator.generate();

      expect(results).toHaveLength(2);
      expect(results[0].tableName).toBe("users");
      expect(results[0].className).toBe("User");
      expect(results[0].fileName).toBe("user.entity.ts");
      expect(results[0].code).toContain("export class User");
      expect(results[1].tableName).toBe("posts");
      expect(results[1].className).toBe("Post");
    });

    it("should exclude tables specified in excludeTables", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("pg_tables")) {
          return [
            { table_name: "users" },
            { table_name: "__migrations" },
          ];
        }

        if (sqlText.includes("information_schema") && sqlText.includes("columns")) {
          return [
            { column_name: "id", data_type: "integer", is_nullable: "NO" },
          ];
        }

        if (sqlText.includes("pg_index")) {
          return [{ column_name: "id" }];
        }

        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "postgres", {
        excludeTables: ["__migrations"],
      });
      const results = await generator.generate();

      expect(results).toHaveLength(1);
      expect(results[0].tableName).toBe("users");
    });

    it("should include only specified tables when includeTables is set", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("pg_tables")) {
          return [
            { table_name: "users" },
            { table_name: "posts" },
            { table_name: "comments" },
          ];
        }

        if (sqlText.includes("information_schema") && sqlText.includes("columns")) {
          return [
            { column_name: "id", data_type: "integer", is_nullable: "NO" },
          ];
        }

        if (sqlText.includes("pg_index")) {
          return [{ column_name: "id" }];
        }

        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "postgres", {
        includeTables: ["users"],
      });
      const results = await generator.generate();

      expect(results).toHaveLength(1);
      expect(results[0].tableName).toBe("users");
    });
  });

  describe("discoverTables()", () => {
    it("should discover MySQL tables", async () => {
      const mockQueryFn = jest.fn(async () => {
        return { results: [{ table_name: "users" }, { table_name: "posts" }] };
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "mysql");
      const tables = await generator.discoverTables();

      expect(tables).toEqual(["users", "posts"]);
    });

    it("should discover SQLite tables and skip sqlite_* internals", async () => {
      const seenSql: string[] = [];
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");
        seenSql.push(sqlText);
        return [{ table_name: "users" }, { table_name: "posts" }];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "sqlite");
      const tables = await generator.discoverTables();

      expect(tables).toEqual(["users", "posts"]);
      expect(seenSql[0]).toContain("sqlite_master");
      expect(seenSql[0]).toContain("sqlite_%");
    });

    it("should discover PostgreSQL tables", async () => {
      const mockQueryFn = jest.fn(async () => {
        return { rows: [{ table_name: "users" }] };
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "postgres");
      const tables = await generator.discoverTables();

      expect(tables).toEqual(["users"]);
    });
  });

  describe("getColumns()", () => {
    it("should return column metadata", async () => {
      const mockQueryFn = jest.fn(async () => {
        return [
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          { column_name: "name", data_type: "character varying", is_nullable: "YES", character_maximum_length: 100 },
        ];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "postgres");
      const columns = await generator.getColumns("users");

      expect(columns).toHaveLength(2);
      expect(columns[0].column_name).toBe("id");
      expect(columns[1].character_maximum_length).toBe(100);
    });

    it("should select EXTRA as extra for MySQL so AUTO_INCREMENT PKs become @PrimaryGeneratedColumn", async () => {
      // Regression for #346: MySQL getColumns previously omitted EXTRA, so
      // isGeneratedPrimaryKey() never saw "auto_increment" and emitted
      // @PrimaryColumn() instead of @PrimaryGeneratedColumn().
      const seenSqlTexts: string[] = [];
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");
        seenSqlTexts.push(sqlText);

        if (sqlText.includes("information_schema.TABLES")) {
          return [{ table_name: "post" }];
        }
        if (sqlText.includes("information_schema.COLUMNS")) {
          return [
            {
              column_name: "id",
              data_type: "int",
              is_nullable: "NO",
              column_default: null,
              extra: "auto_increment",
            },
            {
              column_name: "title",
              data_type: "varchar",
              is_nullable: "NO",
              character_maximum_length: 255,
              column_default: null,
              extra: "",
            },
          ];
        }
        if (sqlText.includes("KEY_COLUMN_USAGE") && sqlText.includes("PRIMARY")) {
          return [{ column_name: "id" }];
        }
        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "mysql");
      const entities = await generator.generate();

      const columnsSql = seenSqlTexts.find((s) =>
        s.includes("information_schema.COLUMNS"),
      );
      expect(columnsSql).toBeDefined();
      expect(columnsSql).toMatch(/EXTRA\s+as\s+extra/i);

      expect(entities).toHaveLength(1);
      expect(entities[0].code).toContain("@PrimaryGeneratedColumn()");
      expect(entities[0].code).not.toContain("@PrimaryColumn()");
    });
  });

  describe("SQLite end-to-end generation", () => {
    it("should generate an entity from SQLite PRAGMA results with INTEGER rowid PK", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("sqlite_master")) {
          return [{ table_name: "users" }];
        }
        if (sqlText.includes("PRAGMA table_info")) {
          return [
            { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
            { cid: 1, name: "name", type: "VARCHAR(255)", notnull: 1, dflt_value: null, pk: 0 },
            { cid: 2, name: "active", type: "BOOLEAN", notnull: 1, dflt_value: "1", pk: 0 },
            { cid: 3, name: "amount", type: "DECIMAL(12,2)", notnull: 0, dflt_value: null, pk: 0 },
          ];
        }
        if (sqlText.includes("PRAGMA foreign_key_list")) {
          return [];
        }
        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "sqlite");
      const entities = await generator.generate();

      expect(entities).toHaveLength(1);
      const code = entities[0].code;

      // Single INTEGER PK should be a rowid alias → @PrimaryGeneratedColumn
      expect(code).toContain("@PrimaryGeneratedColumn()");
      expect(code).toContain("id!: number;");

      // VARCHAR(255) → varchar + length
      expect(code).toContain('@Column({ type: "varchar", length: 255 })');
      expect(code).toContain("name!: string;");

      // BOOLEAN + default 1 → boolean true default
      expect(code).toContain('@Column({ type: "boolean", default: true })');

      // DECIMAL(12,2) → double + precision/scale + nullable
      expect(code).toContain(
        '@Column({ type: "double", precision: 12, scale: 2, nullable: true })',
      );
    });

    it("should produce @ManyToOne from SQLite PRAGMA foreign_key_list", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("sqlite_master")) {
          return [{ table_name: "posts" }];
        }
        if (sqlText.includes("PRAGMA table_info")) {
          return [
            { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
            { cid: 1, name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
            { cid: 2, name: "author_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
          ];
        }
        if (sqlText.includes("PRAGMA foreign_key_list")) {
          return [{ id: 0, seq: 0, table: "users", from: "author_id", to: "id" }];
        }
        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "sqlite");
      const entities = await generator.generate();

      expect(entities).toHaveLength(1);
      const code = entities[0].code;
      expect(code).toContain("@ManyToOne(() => User, (entity: any) => entity.author)");
      expect(code).toContain('@RelationColumn({ name: "author_id" })');
    });

    it("should reject SQLite table names containing NUL characters", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("sqlite_master")) {
          return [{ table_name: `bad${String.fromCharCode(0)}name` }];
        }
        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "sqlite");
      await expect(generator.generate()).rejects.toThrow(/NUL/);
    });
  });

  describe("getIndexes()", () => {
    it("should collapse MySQL STATISTICS rows into one DbIndex per index", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("information_schema.STATISTICS")) {
          return [
            { index_name: "idx_user_email", column_name: "email", non_unique: 0, seq_in_index: 1 },
            { index_name: "idx_user_active_email", column_name: "active", non_unique: 1, seq_in_index: 1 },
            { index_name: "idx_user_active_email", column_name: "email", non_unique: 1, seq_in_index: 2 },
          ];
        }
        if (sqlText.includes("REFERENCED_TABLE_NAME")) {
          return [];
        }
        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "mysql");
      const indexes = await generator.getIndexes("users");

      expect(indexes).toHaveLength(2);
      const unique = indexes.find((i) => i.name === "idx_user_email")!;
      expect(unique.is_unique).toBe(true);
      expect(unique.column_names).toEqual(["email"]);

      const composite = indexes.find((i) => i.name === "idx_user_active_email")!;
      expect(composite.is_unique).toBe(false);
      expect(composite.column_names).toEqual(["active", "email"]);
    });

    it("should drop single-column indexes that exactly cover a FK column", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("information_schema.STATISTICS")) {
          return [
            { index_name: "fk_implicit_idx", column_name: "author_id", non_unique: 1, seq_in_index: 1 },
            { index_name: "idx_email", column_name: "email", non_unique: 0, seq_in_index: 1 },
          ];
        }
        if (sqlText.includes("REFERENCED_TABLE_NAME")) {
          return [
            { column_name: "author_id", referenced_table: "users", referenced_column: "id" },
          ];
        }
        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "mysql");
      const indexes = await generator.getIndexes("posts");

      expect(indexes.map((i) => i.name)).toEqual(["idx_email"]);
    });

    it("should aggregate SQLite PRAGMA index_list + index_info into DbIndex[]", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("PRAGMA index_list")) {
          return [
            { seq: 0, name: "uq_users_email", unique: 1, origin: "u", partial: 0 },
            { seq: 1, name: "idx_users_active_email", unique: 0, origin: "c", partial: 0 },
            { seq: 2, name: "sqlite_autoindex_users_1", unique: 1, origin: "pk", partial: 0 },
          ];
        }
        if (sqlText.includes("PRAGMA index_info") && sqlText.includes("uq_users_email")) {
          return [{ seqno: 0, cid: 1, name: "email" }];
        }
        if (sqlText.includes("PRAGMA index_info") && sqlText.includes("idx_users_active_email")) {
          return [
            { seqno: 0, cid: 2, name: "active" },
            { seqno: 1, cid: 1, name: "email" },
          ];
        }
        if (sqlText.includes("PRAGMA foreign_key_list")) return [];
        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "sqlite");
      const indexes = await generator.getIndexes("users");

      // PK auto-index dropped, two user-defined indexes remain.
      expect(indexes).toHaveLength(2);
      const uq = indexes.find((i) => i.name === "uq_users_email")!;
      expect(uq.is_unique).toBe(true);
      expect(uq.column_names).toEqual(["email"]);
      const composite = indexes.find((i) => i.name === "idx_users_active_email")!;
      expect(composite.is_unique).toBe(false);
      expect(composite.column_names).toEqual(["active", "email"]);
    });
  });

  describe("ENUM resolution", () => {
    it("should fetch PostgreSQL enum labels and embed them in the generated entity", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("pg_tables")) {
          return [{ table_name: "orders" }];
        }
        if (sqlText.includes("information_schema.columns") || sqlText.includes("information_schema.COLUMNS")) {
          return [
            {
              column_name: "id",
              data_type: "integer",
              is_nullable: "NO",
              column_default: "nextval('orders_id_seq'::regclass)",
            },
            {
              column_name: "status",
              data_type: "USER-DEFINED",
              udt_name: "order_status",
              is_nullable: "NO",
            },
          ];
        }
        if (sqlText.includes("pg_enum")) {
          return [
            { type_name: "order_status", label: "pending" },
            { type_name: "order_status", label: "shipped" },
            { type_name: "order_status", label: "delivered" },
          ];
        }
        if (sqlText.includes("pg_index")) {
          return [{ column_name: "id" }];
        }
        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "postgres");
      const entities = await generator.generate();

      expect(entities).toHaveLength(1);
      expect(entities[0].code).toContain(
        '@Column({ type: "enum", enum: ["pending", "shipped", "delivered"] })',
      );
    });

    it("should parse MySQL enum labels out of COLUMN_TYPE", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("information_schema.TABLES")) {
          return [{ table_name: "users" }];
        }
        if (sqlText.includes("information_schema.COLUMNS")) {
          return [
            {
              column_name: "id",
              data_type: "int",
              is_nullable: "NO",
              extra: "auto_increment",
            },
            {
              column_name: "role",
              data_type: "enum",
              column_type: "enum('admin','user','guest')",
              is_nullable: "NO",
            },
          ];
        }
        if (sqlText.includes("KEY_COLUMN_USAGE") && sqlText.includes("PRIMARY")) {
          return [{ column_name: "id" }];
        }
        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "mysql");
      const entities = await generator.generate();

      expect(entities).toHaveLength(1);
      expect(entities[0].code).toContain(
        '@Column({ type: "enum", enum: ["admin", "user", "guest"] })',
      );
    });

    it("should handle MySQL enum labels containing escaped quotes", async () => {
      const mockQueryFn = jest.fn(async (sqlInput: any) => {
        const sqlText = typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");

        if (sqlText.includes("information_schema.TABLES")) {
          return [{ table_name: "quotes" }];
        }
        if (sqlText.includes("information_schema.COLUMNS")) {
          return [
            { column_name: "id", data_type: "int", is_nullable: "NO", extra: "auto_increment" },
            {
              column_name: "label",
              data_type: "enum",
              column_type: "enum('it''s','two''quotes','plain')",
              is_nullable: "NO",
            },
          ];
        }
        if (sqlText.includes("KEY_COLUMN_USAGE") && sqlText.includes("PRIMARY")) {
          return [{ column_name: "id" }];
        }
        return [];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "mysql");
      const entities = await generator.generate();

      expect(entities[0].code).toContain(
        `@Column({ type: "enum", enum: ["it's", "two'quotes", "plain"] })`,
      );
    });
  });

  describe("getPrimaryKeys()", () => {
    it("should return primary key column names", async () => {
      const mockQueryFn = jest.fn(async () => {
        return [{ column_name: "id" }];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "postgres");
      const pks = await generator.getPrimaryKeys("users");

      expect(pks).toEqual(["id"]);
    });
  });

  describe("getForeignKeys()", () => {
    it("should return foreign key metadata", async () => {
      const mockQueryFn = jest.fn(async () => {
        return [
          {
            column_name: "author_id",
            referenced_table: "users",
            referenced_column: "id",
            constraint_name: "fk_posts_author",
          },
        ];
      });

      const generator = new IntrospectionGenerator(mockQueryFn, "postgres");
      const fks = await generator.getForeignKeys("posts");

      expect(fks).toHaveLength(1);
      expect(fks[0].column_name).toBe("author_id");
      expect(fks[0].referenced_table).toBe("users");
    });
  });
});
