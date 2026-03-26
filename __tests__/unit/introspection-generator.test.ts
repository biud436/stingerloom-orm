/* eslint-disable @typescript-eslint/no-explicit-any */
import { IntrospectionTypeMapper } from "../../src/introspection/TypeMapper";
import {
  EntityCodeBuilder,
  DbColumn,
  DbForeignKey,
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

  describe("build() — FK generates @ManyToOne", () => {
    it("should produce @ManyToOne with correct 3-arg signature and import for FK columns", () => {
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

      // Should contain ManyToOne import
      expect(code).toContain("ManyToOne");
      // Should NOT contain author_id as a plain @Column
      expect(code).not.toMatch(/@Column\([^)]*\)\s*\n\s*authorId/);
      // Should contain ManyToOne relation with correct 3-arg signature
      expect(code).toContain('@ManyToOne(() => User, (entity: any) => entity.author, { joinColumn: "author_id" })');
      expect(code).toContain("author!: User;");
      // Should contain import for referenced User class
      expect(code).toContain('import { User } from "./user.entity";');
      // Should contain @Entity with table name
      expect(code).toContain('@Entity({ name: "posts" })');
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
