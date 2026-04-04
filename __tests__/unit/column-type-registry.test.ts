import "reflect-metadata";
import {
  ColumnTypeRegistry,
  CustomColumnTypeDefinition,
} from "../../src/core/ColumnTypeRegistry";
import { MySqlColumnDefinitionBuilder } from "../../src/dialects/mysql/MySqlColumnDefinitionBuilder";
import { PostgresColumnDefinitionBuilder } from "../../src/dialects/postgres/PostgresColumnDefinitionBuilder";
import { SqliteColumnDefinitionBuilder } from "../../src/dialects/sqlite/SqliteColumnDefinitionBuilder";

describe("ColumnTypeRegistry", () => {
  let registry: ColumnTypeRegistry;

  beforeEach(() => {
    ColumnTypeRegistry.resetInstance();
    registry = ColumnTypeRegistry.getInstance();
  });

  afterEach(() => {
    registry.clear();
    ColumnTypeRegistry.resetInstance();
  });

  // ── Singleton ──────────────────────────────────────────

  it("should return the same singleton instance", () => {
    const a = ColumnTypeRegistry.getInstance();
    const b = ColumnTypeRegistry.getInstance();
    expect(a).toBe(b);
  });

  it("should return a fresh instance after resetInstance()", () => {
    const a = ColumnTypeRegistry.getInstance();
    a.register("custom", { mysql: "TEXT" });
    ColumnTypeRegistry.resetInstance();
    const b = ColumnTypeRegistry.getInstance();
    expect(b.has("custom")).toBe(false);
  });

  // ── Registration ───────────────────────────────────────

  it("should register and retrieve a custom type", () => {
    const def: CustomColumnTypeDefinition = {
      mysql: "GEOMETRY",
      postgres: "geometry(Point, 4326)",
      sqlite: "TEXT",
    };
    registry.register("geometry", def);

    expect(registry.has("geometry")).toBe(true);
    expect(registry.get("geometry")).toBe(def);
  });

  it("should unregister a custom type", () => {
    registry.register("hstore", { postgres: "hstore" });
    expect(registry.has("hstore")).toBe(true);

    registry.unregister("hstore");
    expect(registry.has("hstore")).toBe(false);
  });

  it("should return undefined for unregistered types", () => {
    expect(registry.has("nope")).toBe(false);
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.resolve("nope", "mysql")).toBeUndefined();
    expect(registry.getTransformer("nope")).toBeUndefined();
  });

  it("should list registered type names", () => {
    registry.register("cidr", { postgres: "cidr" });
    registry.register("geometry", { mysql: "GEOMETRY" });
    expect(registry.getRegisteredNames()).toEqual(
      expect.arrayContaining(["cidr", "geometry"]),
    );
  });

  it("should clear all registrations", () => {
    registry.register("a", { mysql: "A" });
    registry.register("b", { postgres: "B" });
    registry.clear();
    expect(registry.getRegisteredNames()).toHaveLength(0);
  });

  // ── Per-dialect resolution ─────────────────────────────

  it("should resolve per-dialect type", () => {
    registry.register("geometry", {
      mysql: "GEOMETRY",
      postgres: "geometry(Point, 4326)",
      sqlite: "TEXT",
    });

    expect(registry.resolve("geometry", "mysql")).toBe("GEOMETRY");
    expect(registry.resolve("geometry", "postgres")).toBe("geometry(Point, 4326)");
    expect(registry.resolve("geometry", "sqlite")).toBe("TEXT");
  });

  it("should return undefined for a dialect without mapping", () => {
    registry.register("hstore", { postgres: "hstore" });
    expect(registry.resolve("hstore", "mysql")).toBeUndefined();
    expect(registry.resolve("hstore", "sqlite")).toBeUndefined();
  });

  // ── Transformer ────────────────────────────────────────

  it("should store and retrieve a transformer", () => {
    const to = jest.fn((v) => `to:${v}`);
    const from = jest.fn((v) => `from:${v}`);

    registry.register("geometry", {
      postgres: "geometry",
      transformer: { to, from },
    });

    const transformer = registry.getTransformer("geometry");
    expect(transformer).toBeDefined();
    expect(transformer!.to("hello")).toBe("to:hello");
    expect(transformer!.from("world")).toBe("from:world");
  });

  it("should return undefined transformer for type without transformer", () => {
    registry.register("cidr", { postgres: "cidr" });
    expect(registry.getTransformer("cidr")).toBeUndefined();
  });

  // ── Override behavior ──────────────────────────────────

  it("should allow overriding an existing registration", () => {
    registry.register("geometry", { mysql: "GEOMETRY" });
    registry.register("geometry", { mysql: "POINT" });
    expect(registry.resolve("geometry", "mysql")).toBe("POINT");
  });
});

describe("ColumnTypeRegistry integration with ColumnDefinitionBuilders", () => {
  let registry: ColumnTypeRegistry;

  beforeEach(() => {
    ColumnTypeRegistry.resetInstance();
    registry = ColumnTypeRegistry.getInstance();
  });

  afterEach(() => {
    registry.clear();
    ColumnTypeRegistry.resetInstance();
  });

  // ── MySQL ──────────────────────────────────────────────

  describe("MySqlColumnDefinitionBuilder", () => {
    const builder = new MySqlColumnDefinitionBuilder();

    it("should use built-in type when no custom type is registered", () => {
      expect(builder.castType("varchar")).toBe("VARCHAR");
      expect(builder.castType("int")).toBe("INT");
      expect(builder.castType("uuid")).toBe("CHAR(36)");
    });

    it("should resolve custom type from registry", () => {
      registry.register("geometry", {
        mysql: "GEOMETRY",
        postgres: "geometry(Point, 4326)",
        sqlite: "TEXT",
      });

      expect(builder.castType("geometry")).toBe("GEOMETRY");
    });

    it("should fall back to castBuiltinType for unregistered dialect", () => {
      registry.register("hstore", { postgres: "hstore" });
      // MySQL has no mapping → falls through to castBuiltinType default case
      expect(builder.castType("hstore")).toBe("hstore");
    });

    it("should use custom type's SQL string literally", () => {
      registry.register("money", { mysql: "DECIMAL(19, 4)" });
      expect(builder.castType("money")).toBe("DECIMAL(19, 4)");
    });
  });

  // ── PostgreSQL ─────────────────────────────────────────

  describe("PostgresColumnDefinitionBuilder", () => {
    const builder = new PostgresColumnDefinitionBuilder();

    it("should use built-in type when no custom type is registered", () => {
      expect(builder.castType("varchar")).toBe("VARCHAR");
      expect(builder.castType("int")).toBe("INTEGER");
      expect(builder.castType("uuid")).toBe("UUID");
    });

    it("should resolve custom type from registry", () => {
      registry.register("geometry", {
        mysql: "GEOMETRY",
        postgres: "geometry(Point, 4326)",
      });

      expect(builder.castType("geometry")).toBe("geometry(Point, 4326)");
    });

    it("should resolve PostGIS-style complex types", () => {
      registry.register("geography", {
        postgres: "geography(POINT, 4326)",
        mysql: "POINT",
        sqlite: "TEXT",
      });
      expect(builder.castType("geography")).toBe("geography(POINT, 4326)");
    });
  });

  // ── SQLite ─────────────────────────────────────────────

  describe("SqliteColumnDefinitionBuilder", () => {
    const builder = new SqliteColumnDefinitionBuilder();

    it("should use built-in type when no custom type is registered", () => {
      expect(builder.castType("varchar")).toBe("TEXT");
      expect(builder.castType("int")).toBe("INTEGER");
    });

    it("should resolve custom type from registry with TEXT fallback", () => {
      registry.register("geometry", {
        mysql: "GEOMETRY",
        postgres: "geometry(Point, 4326)",
        sqlite: "TEXT",
      });

      expect(builder.castType("geometry")).toBe("TEXT");
    });
  });

  // ── Cross-dialect consistency ──────────────────────────

  it("should resolve different SQL types per dialect for the same abstract type", () => {
    registry.register("money", {
      mysql: "DECIMAL(19, 4)",
      postgres: "MONEY",
      sqlite: "REAL",
    });

    const mysql = new MySqlColumnDefinitionBuilder();
    const pg = new PostgresColumnDefinitionBuilder();
    const sqlite = new SqliteColumnDefinitionBuilder();

    expect(mysql.castType("money")).toBe("DECIMAL(19, 4)");
    expect(pg.castType("money")).toBe("MONEY");
    expect(sqlite.castType("money")).toBe("REAL");
  });

  it("should not affect built-in types even when registry has entries", () => {
    registry.register("custom", { mysql: "CUSTOM_TYPE" });

    const mysql = new MySqlColumnDefinitionBuilder();
    // Built-in types are resolved by castBuiltinType, not affected by registry
    expect(mysql.castType("varchar")).toBe("VARCHAR");
    expect(mysql.castType("boolean")).toBe("TINYINT($n)");
  });

  // ── buildColumnDef integration ─────────────────────────

  it("should produce correct column DDL with custom type (MySQL)", () => {
    registry.register("geometry", { mysql: "GEOMETRY" });

    const builder = new MySqlColumnDefinitionBuilder();
    const ddl = builder.buildColumnDef(
      { type: "geometry", nullable: true, length: 0 },
      { columnName: "location", tableName: "places" },
    );

    expect(ddl).toContain("GEOMETRY");
    expect(ddl).toContain("`location`");
    expect(ddl).toContain("NULL");
  });

  it("should produce correct column DDL with custom type (PostgreSQL)", () => {
    registry.register("geometry", { postgres: "geometry(Point, 4326)" });

    const builder = new PostgresColumnDefinitionBuilder();
    const ddl = builder.buildColumnDef(
      { type: "geometry", nullable: false, length: 0 },
      { columnName: "location", tableName: "places" },
    );

    expect(ddl).toContain("geometry(Point, 4326)");
    expect(ddl).toContain('"location"');
    expect(ddl).toContain("NOT NULL");
  });
});
