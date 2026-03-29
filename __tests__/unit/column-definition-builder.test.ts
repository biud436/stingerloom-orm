import "reflect-metadata";
import { MySqlColumnDefinitionBuilder } from "../../src/dialects/mysql/MySqlColumnDefinitionBuilder";
import { PostgresColumnDefinitionBuilder } from "../../src/dialects/postgres/PostgresColumnDefinitionBuilder";
import { SqliteColumnDefinitionBuilder } from "../../src/dialects/sqlite/SqliteColumnDefinitionBuilder";
import {
  createColumnDefinitionBuilder,
  ColumnDefContext,
} from "../../src/dialects/ColumnDefinitionBuilder";
import { ColumnOption } from "../../src/decorators/Column";

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

describe("createColumnDefinitionBuilder factory", () => {
  it("should create MySqlColumnDefinitionBuilder for mysql", () => {
    const builder = createColumnDefinitionBuilder("mysql");
    expect(builder).toBeInstanceOf(MySqlColumnDefinitionBuilder);
  });

  it("should create PostgresColumnDefinitionBuilder for postgres", () => {
    const builder = createColumnDefinitionBuilder("postgres");
    expect(builder).toBeInstanceOf(PostgresColumnDefinitionBuilder);
  });

  it("should create SqliteColumnDefinitionBuilder for sqlite", () => {
    const builder = createColumnDefinitionBuilder("sqlite");
    expect(builder).toBeInstanceOf(SqliteColumnDefinitionBuilder);
  });
});

describe("defaultColumnOption", () => {
  it("each builder should have varchar type, length 255, nullable false by default", () => {
    const expected = { type: "varchar", length: 255, nullable: false };
    expect(new MySqlColumnDefinitionBuilder().defaultColumnOption).toEqual(expected);
    expect(new PostgresColumnDefinitionBuilder().defaultColumnOption).toEqual(expected);
    expect(new SqliteColumnDefinitionBuilder().defaultColumnOption).toEqual(expected);
  });
});

// ═══════════════════════════════════════════════════════════════
// MySQL ColumnDefinitionBuilder
// ═══════════════════════════════════════════════════════════════

describe("MySqlColumnDefinitionBuilder", () => {
  const builder = new MySqlColumnDefinitionBuilder();
  const ctx: ColumnDefContext = { columnName: "test_col", tableName: "users" };

  describe("castType", () => {
    it("varchar → VARCHAR", () => expect(builder.castType("varchar")).toBe("VARCHAR"));
    it("int → INT", () => expect(builder.castType("int")).toBe("INT"));
    it("number → INT", () => expect(builder.castType("number")).toBe("INT"));
    it("boolean → TINYINT($n)", () => expect(builder.castType("boolean")).toBe("TINYINT($n)"));
    it("datetime → DATETIME", () => expect(builder.castType("datetime")).toBe("DATETIME"));
    it("timestamp → TIMESTAMP", () => expect(builder.castType("timestamp")).toBe("TIMESTAMP"));
    it("timestamptz → DATETIME", () => expect(builder.castType("timestamptz")).toBe("DATETIME"));
    it("float → FLOAT", () => expect(builder.castType("float")).toBe("FLOAT"));
    it("double → DECIMAL($precision, $scale)", () => expect(builder.castType("double")).toBe("DECIMAL($precision, $scale)"));
    it("blob → BLOB", () => expect(builder.castType("blob")).toBe("BLOB"));
    it("text → TEXT", () => expect(builder.castType("text")).toBe("TEXT"));
    it("longtext → LONGTEXT", () => expect(builder.castType("longtext")).toBe("LONGTEXT"));
    it("bigint → BIGINT", () => expect(builder.castType("bigint")).toBe("BIGINT"));
    it("json → JSON", () => expect(builder.castType("json")).toBe("JSON"));
    it("jsonb → JSON", () => expect(builder.castType("jsonb")).toBe("JSON"));
    it("array → JSON", () => expect(builder.castType("array")).toBe("JSON"));
    it("char → CHAR", () => expect(builder.castType("char")).toBe("CHAR"));
    it("enum → ENUM", () => expect(builder.castType("enum")).toBe("ENUM"));
    it("uuid → CHAR(36)", () => expect(builder.castType("uuid")).toBe("CHAR(36)"));
  });

  describe("wrapIdentifier", () => {
    it("should wrap with backticks", () => {
      expect(builder.wrapIdentifier("name")).toBe("`name`");
    });
    it("should escape backticks", () => {
      expect(builder.wrapIdentifier("na`me")).toBe("`na``me`");
    });
  });

  describe("buildColumnDef", () => {
    it("varchar with length", () => {
      const option: ColumnOption = { type: "varchar", length: 100, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toBe("`test_col` VARCHAR(100) NOT NULL");
    });

    it("nullable column", () => {
      const option: ColumnOption = { type: "text", nullable: true };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toBe("`test_col` TEXT NULL");
    });

    it("primary key", () => {
      const option: ColumnOption = { type: "int", primary: true, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toBe("`test_col` INT NOT NULL PRIMARY KEY");
    });

    it("auto increment", () => {
      const option: ColumnOption = { type: "int", primary: true, autoIncrement: true, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("AUTO_INCREMENT");
      expect(result).toContain("PRIMARY KEY");
    });

    it("boolean → TINYINT(1)", () => {
      const option: ColumnOption = { type: "boolean", nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("TINYINT(1)");
    });

    it("boolean with custom length", () => {
      const option: ColumnOption = { type: "boolean", length: 2, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("TINYINT(2)");
    });

    it("enum with values", () => {
      const option: ColumnOption = { type: "enum", enumValues: ["admin", "user", "guest"], nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("ENUM('admin','user','guest')");
    });

    it("enum with single quote in value", () => {
      const option: ColumnOption = { type: "enum", enumValues: ["it's"], nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("ENUM('it''s')");
    });

    it("decimal with precision/scale", () => {
      const option: ColumnOption = { type: "double", precision: 8, scale: 3, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DECIMAL(8, 3)");
    });

    it("decimal default precision/scale", () => {
      const option: ColumnOption = { type: "double", nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DECIMAL(10, 2)");
    });

    it("decimal precision > 65 throws", () => {
      const option: ColumnOption = { type: "double", precision: 100, nullable: false };
      expect(() => builder.buildColumnDef(option, ctx)).toThrow("65");
    });

    it("DEFAULT number", () => {
      const option: ColumnOption = { type: "int", nullable: false, default: 42 };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DEFAULT 42");
    });

    it("DEFAULT string", () => {
      const option: ColumnOption = { type: "varchar", length: 50, nullable: false, default: "active" };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DEFAULT 'active'");
    });

    it("DEFAULT boolean uses 0/1", () => {
      const option: ColumnOption = { type: "boolean", nullable: false, default: true };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DEFAULT 1");
    });

    it("DEFAULT null", () => {
      const option: ColumnOption = { type: "varchar", length: 50, nullable: true, default: null };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DEFAULT NULL");
    });

    it("DEFAULT raw SQL expression", () => {
      const option: ColumnOption = { type: "timestamp", nullable: false, default: "(CURRENT_TIMESTAMP)" };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DEFAULT (CURRENT_TIMESTAMP)");
    });

    it("composite PK should not include inline PRIMARY KEY", () => {
      const option: ColumnOption = { type: "int", primary: true, nullable: false };
      const result = builder.buildColumnDef(option, { ...ctx, isCompositePk: true });
      expect(result).not.toContain("PRIMARY KEY");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PostgreSQL ColumnDefinitionBuilder
// ═══════════════════════════════════════════════════════════════

describe("PostgresColumnDefinitionBuilder", () => {
  const builder = new PostgresColumnDefinitionBuilder("public");
  const ctx: ColumnDefContext = { columnName: "test_col", tableName: "users" };

  describe("castType", () => {
    it("varchar → VARCHAR", () => expect(builder.castType("varchar")).toBe("VARCHAR"));
    it("int → INTEGER", () => expect(builder.castType("int")).toBe("INTEGER"));
    it("number → INTEGER", () => expect(builder.castType("number")).toBe("INTEGER"));
    it("boolean → BOOLEAN", () => expect(builder.castType("boolean")).toBe("BOOLEAN"));
    it("datetime → TIMESTAMP", () => expect(builder.castType("datetime")).toBe("TIMESTAMP"));
    it("timestamp → TIMESTAMP", () => expect(builder.castType("timestamp")).toBe("TIMESTAMP"));
    it("timestamptz → TIMESTAMPTZ", () => expect(builder.castType("timestamptz")).toBe("TIMESTAMPTZ"));
    it("float → REAL", () => expect(builder.castType("float")).toBe("REAL"));
    it("double → NUMERIC($precision, $scale)", () => expect(builder.castType("double")).toBe("NUMERIC($precision, $scale)"));
    it("blob → BYTEA", () => expect(builder.castType("blob")).toBe("BYTEA"));
    it("text → TEXT", () => expect(builder.castType("text")).toBe("TEXT"));
    it("longtext → TEXT", () => expect(builder.castType("longtext")).toBe("TEXT"));
    it("bigint → BIGINT", () => expect(builder.castType("bigint")).toBe("BIGINT"));
    it("json → JSON", () => expect(builder.castType("json")).toBe("JSON"));
    it("jsonb → JSONB", () => expect(builder.castType("jsonb")).toBe("JSONB"));
    it("char → CHAR", () => expect(builder.castType("char")).toBe("CHAR"));
    it("enum → USER-DEFINED", () => expect(builder.castType("enum")).toBe("USER-DEFINED"));
    it("array → ARRAY", () => expect(builder.castType("array")).toBe("ARRAY"));
    it("uuid → UUID", () => expect(builder.castType("uuid")).toBe("UUID"));
  });

  describe("wrapIdentifier", () => {
    it("should wrap with double quotes", () => {
      expect(builder.wrapIdentifier("name")).toBe('"name"');
    });
    it("should escape double quotes", () => {
      expect(builder.wrapIdentifier('na"me')).toBe('"na""me"');
    });
  });

  describe("buildColumnDef", () => {
    it("varchar with length", () => {
      const option: ColumnOption = { type: "varchar", length: 100, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toBe('"test_col" VARCHAR(100) NOT NULL');
    });

    it("nullable column", () => {
      const option: ColumnOption = { type: "text", nullable: true };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toBe('"test_col" TEXT NULL');
    });

    it("primary key", () => {
      const option: ColumnOption = { type: "int", primary: true, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("PRIMARY KEY");
    });

    it("auto increment → SERIAL", () => {
      const option: ColumnOption = { type: "int", primary: true, autoIncrement: true, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("SERIAL");
      expect(result).toContain("NOT NULL");
      expect(result).toContain("PRIMARY KEY");
    });

    it("boolean → BOOLEAN (native)", () => {
      const option: ColumnOption = { type: "boolean", nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("BOOLEAN");
      expect(result).not.toContain("TINYINT");
    });

    it("enum → schema-qualified type", () => {
      const option: ColumnOption = { type: "enum", nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain('"public"."users_test_col_enum"');
    });

    it("enum with custom enumName", () => {
      const option: ColumnOption = { type: "enum", enumName: "user_role", nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain('"public"."user_role"');
    });

    it("decimal with precision/scale", () => {
      const option: ColumnOption = { type: "double", precision: 12, scale: 4, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("NUMERIC(12, 4)");
    });

    it("decimal precision > 1000 throws", () => {
      const option: ColumnOption = { type: "double", precision: 1500, nullable: false };
      expect(() => builder.buildColumnDef(option, ctx)).toThrow("1000");
    });

    it("UUID PK with generation strategy", () => {
      const option: ColumnOption = {
        type: "uuid", primary: true, generationStrategy: "uuid", nullable: false,
      };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("UUID");
      expect(result).toContain("DEFAULT gen_random_uuid()");
      expect(result).toContain("PRIMARY KEY");
    });

    it("UUID without generation strategy → no DEFAULT", () => {
      const option: ColumnOption = { type: "uuid", nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("UUID");
      expect(result).not.toContain("DEFAULT");
    });

    it("UUID should not add length (fixed-size type)", () => {
      const option: ColumnOption = { type: "uuid", length: 36, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).not.toContain("UUID(36)");
    });

    it("DEFAULT boolean uses TRUE/FALSE", () => {
      const option: ColumnOption = { type: "boolean", nullable: false, default: true };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DEFAULT TRUE");
    });

    it("DEFAULT string with single quotes escaped", () => {
      const option: ColumnOption = { type: "varchar", length: 50, nullable: false, default: "it's" };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DEFAULT 'it''s'");
    });

    it("custom schema", () => {
      const customBuilder = new PostgresColumnDefinitionBuilder("tenant_1");
      const option: ColumnOption = { type: "enum", nullable: false };
      const result = customBuilder.buildColumnDef(option, ctx);
      expect(result).toContain('"tenant_1"."users_test_col_enum"');
    });

    it("composite PK should not include inline PRIMARY KEY", () => {
      const option: ColumnOption = { type: "int", primary: true, nullable: false };
      const result = builder.buildColumnDef(option, { ...ctx, isCompositePk: true });
      expect(result).not.toContain("PRIMARY KEY");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// SQLite ColumnDefinitionBuilder
// ═══════════════════════════════════════════════════════════════

describe("SqliteColumnDefinitionBuilder", () => {
  const builder = new SqliteColumnDefinitionBuilder();
  const ctx: ColumnDefContext = { columnName: "test_col", tableName: "users" };

  describe("castType", () => {
    it("varchar → TEXT", () => expect(builder.castType("varchar")).toBe("TEXT"));
    it("text → TEXT", () => expect(builder.castType("text")).toBe("TEXT"));
    it("longtext → TEXT", () => expect(builder.castType("longtext")).toBe("TEXT"));
    it("char → TEXT", () => expect(builder.castType("char")).toBe("TEXT"));
    it("enum → TEXT", () => expect(builder.castType("enum")).toBe("TEXT"));
    it("json → TEXT", () => expect(builder.castType("json")).toBe("TEXT"));
    it("jsonb → TEXT", () => expect(builder.castType("jsonb")).toBe("TEXT"));
    it("array → TEXT", () => expect(builder.castType("array")).toBe("TEXT"));
    it("datetime → TEXT", () => expect(builder.castType("datetime")).toBe("TEXT"));
    it("date → TEXT", () => expect(builder.castType("date")).toBe("TEXT"));
    it("timestamp → TEXT", () => expect(builder.castType("timestamp")).toBe("TEXT"));
    it("timestamptz → TEXT", () => expect(builder.castType("timestamptz")).toBe("TEXT"));
    it("int → INTEGER", () => expect(builder.castType("int")).toBe("INTEGER"));
    it("number → INTEGER", () => expect(builder.castType("number")).toBe("INTEGER"));
    it("boolean → INTEGER", () => expect(builder.castType("boolean")).toBe("INTEGER"));
    it("bigint → INTEGER", () => expect(builder.castType("bigint")).toBe("INTEGER"));
    it("float → REAL", () => expect(builder.castType("float")).toBe("REAL"));
    it("double → REAL", () => expect(builder.castType("double")).toBe("REAL"));
    it("blob → BLOB", () => expect(builder.castType("blob")).toBe("BLOB"));
    it("uuid → VARCHAR(36)", () => expect(builder.castType("uuid")).toBe("VARCHAR(36)"));
  });

  describe("wrapIdentifier", () => {
    it("should wrap with double quotes", () => {
      expect(builder.wrapIdentifier("name")).toBe('"name"');
    });
    it("should escape double quotes", () => {
      expect(builder.wrapIdentifier('na"me')).toBe('"na""me"');
    });
  });

  describe("buildColumnDef", () => {
    it("varchar with length", () => {
      const option: ColumnOption = { type: "varchar", length: 100, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("TEXT(100)");
    });

    it("nullable column", () => {
      const option: ColumnOption = { type: "text", nullable: true };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toBe('"test_col" TEXT NULL');
    });

    it("primary key", () => {
      const option: ColumnOption = { type: "int", primary: true, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("PRIMARY KEY");
    });

    it("auto increment → INTEGER PRIMARY KEY AUTOINCREMENT", () => {
      const option: ColumnOption = { type: "int", primary: true, autoIncrement: true, nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toBe('"test_col" INTEGER PRIMARY KEY AUTOINCREMENT');
    });

    it("boolean → INTEGER", () => {
      const option: ColumnOption = { type: "boolean", nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("INTEGER");
      expect(result).not.toContain("BOOLEAN");
      expect(result).not.toContain("TINYINT");
    });

    it("enum → TEXT (no native enum)", () => {
      const option: ColumnOption = { type: "enum", enumValues: ["a", "b"], nullable: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("TEXT");
      expect(result).not.toContain("ENUM");
    });

    it("DEFAULT boolean uses TRUE/FALSE", () => {
      const option: ColumnOption = { type: "boolean", nullable: false, default: false };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DEFAULT FALSE");
    });

    it("DEFAULT number", () => {
      const option: ColumnOption = { type: "int", nullable: false, default: 0 };
      const result = builder.buildColumnDef(option, ctx);
      expect(result).toContain("DEFAULT 0");
    });

    it("composite PK should not include inline PRIMARY KEY", () => {
      const option: ColumnOption = { type: "int", primary: true, nullable: false };
      const result = builder.buildColumnDef(option, { ...ctx, isCompositePk: true });
      expect(result).not.toContain("PRIMARY KEY");
    });
  });
});
