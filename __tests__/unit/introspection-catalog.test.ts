/* eslint-disable @typescript-eslint/no-explicit-any */
import { mysqlTypes, parseMySqlDefault, MySqlCatalogReader } from "../../src/introspection/catalog/mysql";
import {
  parsePostgresDefault,
  PostgresCatalogReader,
  postgresTypes,
} from "../../src/introspection/catalog/postgres";
import {
  parseSqliteDefault,
  SqliteCatalogReader,
  sqliteTypes,
} from "../../src/introspection/catalog/sqlite";
import { CanonicalType, stripOuterParens } from "../../src/introspection/SchemaIR";

/**
 * The catalog layer: each dialect's reading of its own catalog into the
 * schema IR. Everything a database spells its own way — types, defaults,
 * identity, composite keys, index extras — is pinned here, per dialect, so the
 * rest of the pipeline can be tested on the IR alone.
 */

type Route = [string | RegExp, (values: unknown[]) => unknown];

/** A query function answering by the statement text; records every statement. */
function fakeCatalog(routes: Route[]) {
  const seen: string[] = [];
  const fn = jest.fn(async (q: any) => {
    const text: string = typeof q === "string" ? q : q.sql;
    const values: unknown[] = typeof q === "string" ? [] : q.values;
    seen.push(text);
    for (const [pattern, answer] of routes) {
      if (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text)) {
        return answer(values);
      }
    }
    return [];
  });
  return { fn, seen };
}

const int4: CanonicalType = { kind: "integer", bytes: 4, unsigned: false };

describe("PostgreSQL types", () => {
  it.each<[string, CanonicalType]>([
    ["integer", int4],
    ["smallint", { kind: "integer", bytes: 2, unsigned: false }],
    ["bigint", { kind: "integer", bytes: 8, unsigned: false }],
    ["character varying(80)", { kind: "string", fixed: false, length: 80 }],
    ["character varying", { kind: "string", fixed: false, length: null }],
    ["character(1)", { kind: "string", fixed: true, length: 1 }],
    ["numeric(10,2)", { kind: "decimal", precision: 10, scale: 2 }],
    ["numeric(10)", { kind: "decimal", precision: 10, scale: 0 }],
    ["numeric", { kind: "decimal", precision: null, scale: null }],
    ["double precision", { kind: "float", bytes: 8 }],
    ["real", { kind: "float", bytes: 4 }],
    ["timestamp without time zone", { kind: "timestamp", zone: "local", precision: null }],
    ["timestamp(6) without time zone", { kind: "timestamp", zone: "local", precision: null }],
    ["timestamp(3) with time zone", { kind: "timestamp", zone: "instant", precision: 3 }],
    ["time without time zone", { kind: "time", withTimeZone: false, precision: null }],
    ["bytea", { kind: "blob", size: "unbounded" }],
    ["jsonb", { kind: "json", binary: true }],
    ["integer[]", { kind: "array", element: int4 }],
    ["character varying(20)[]", { kind: "array", element: { kind: "string", fixed: false, length: 20 } }],
    ["inet", { kind: "other", native: "inet" }],
    // This ORM's own spellings.
    ["VARCHAR(255)", { kind: "string", fixed: false, length: 255 }],
    ["NUMERIC(10, 2)", { kind: "decimal", precision: 10, scale: 2 }],
    ["TIMESTAMPTZ", { kind: "timestamp", zone: "instant", precision: null }],
    ["TEXT[]", { kind: "array", element: { kind: "text", size: "unbounded" } }],
  ])("%s", (native, expected) => {
    expect(postgresTypes.parseType(native)).toEqual(expected);
  });

  it("resolves a named type through the resolver, quoted and qualified", () => {
    const status: CanonicalType = { kind: "enum", values: ["a", "b"], name: "Post Status" };
    const resolve = (name: string) => (name === "Post Status" ? status : undefined);
    expect(postgresTypes.parseType('"public"."Post Status"', resolve)).toEqual(status);
    expect(postgresTypes.parseType('"Post Status"[]', resolve)).toEqual({
      kind: "array",
      element: status,
    });
    expect(postgresTypes.parseType("my_domain", resolve)).toEqual({
      kind: "other",
      native: "my_domain",
    });
  });

  it("treats an unconstrained varchar as text", () => {
    expect(
      postgresTypes.compareTypes(
        { kind: "string", fixed: false, length: null },
        { kind: "text", size: "unbounded" },
      ),
    ).toBe("equivalent");
  });

  it.each<[string, unknown]>([
    ["'active'::character varying", { kind: "string", value: "active" }],
    ["'it''s'::text", { kind: "string", value: "it's" }],
    ["'{}'::jsonb", { kind: "string", value: "{}" }],
    ["'-1'::integer", { kind: "string", value: "-1" }],
    ["NULL::character varying", { kind: "null" }],
    ["0", { kind: "number", value: "0" }],
    ["(-1.5)", { kind: "number", value: "-1.5" }],
    ["true", { kind: "boolean", value: true }],
    ["nextval('users_id_seq'::regclass)", { kind: "sequence" }],
    ["now()", { kind: "expression", sql: "now()" }],
    ["CURRENT_TIMESTAMP", { kind: "expression", sql: "CURRENT_TIMESTAMP" }],
    ["('a'::text || 'b'::text)", { kind: "expression", sql: "'a'::text || 'b'::text" }],
  ])("default %s", (raw, expected) => {
    expect(parsePostgresDefault(raw)).toEqual(expected);
  });
});

describe("MySQL / MariaDB types", () => {
  it.each<[string, CanonicalType]>([
    ["int(10) unsigned", { kind: "integer", bytes: 4, unsigned: true }],
    ["int", int4],
    ["tinyint(1)", { kind: "boolean" }],
    ["tinyint", { kind: "integer", bytes: 1, unsigned: false }],
    ["tinyint(4)", { kind: "integer", bytes: 1, unsigned: false }],
    ["decimal(10,2)", { kind: "decimal", precision: 10, scale: 2 }],
    ["double", { kind: "float", bytes: 8 }],
    ["float(7,4)", { kind: "float", bytes: 4, digits: { precision: 7, scale: 4 } }],
    ["varchar(255)", { kind: "string", fixed: false, length: 255 }],
    ["char(36)", { kind: "string", fixed: true, length: 36 }],
    ["mediumtext", { kind: "text", size: "medium" }],
    ["longblob", { kind: "blob", size: "long" }],
    ["varbinary(16)", { kind: "binary", fixed: false, length: 16 }],
    ["datetime(3)", { kind: "timestamp", zone: "local", precision: 3 }],
    ["timestamp", { kind: "timestamp", zone: "instant", precision: null }],
    ["json", { kind: "json", binary: false }],
    ["bit(1)", { kind: "other", native: "bit(1)" }],
    ["year", { kind: "other", native: "year" }],
    // This ORM's own spellings.
    ["INT(11)", int4],
    ["DECIMAL(10, 2)", { kind: "decimal", precision: 10, scale: 2 }],
    ["TINYINT(1)", { kind: "boolean" }],
  ])("%s", (native, expected) => {
    expect(mysqlTypes.parseType(native)).toEqual(expected);
  });

  it("reads enum values with both quote escapes", () => {
    expect(mysqlTypes.parseType("enum('a','it''s','back\\\\slash','x\\'y')")).toEqual({
      kind: "enum",
      values: ["a", "it's", "back\\slash", "x'y"],
      name: null,
    });
  });

  const varchar: CanonicalType = { kind: "string", fixed: false, length: 20 };
  const timestamp: CanonicalType = { kind: "timestamp", zone: "instant", precision: null };
  const json: CanonicalType = { kind: "json", binary: false };

  it.each<[string, string | null, CanonicalType, string, unknown]>([
    // MySQL prints a literal's bare value …
    ["mysql", "active", varchar, "", { kind: "string", value: "active" }],
    ["mysql", "now", varchar, "", { kind: "string", value: "now" }],
    ["mysql", "0", int4, "", { kind: "number", value: "0" }],
    ["mysql", "1", { kind: "boolean" }, "", { kind: "boolean", value: true }],
    // … and flags an expression.
    ["mysql", "CURRENT_TIMESTAMP", timestamp, "DEFAULT_GENERATED", { kind: "expression", sql: "CURRENT_TIMESTAMP" }],
    ["mysql", "CURRENT_TIMESTAMP", timestamp, "", { kind: "expression", sql: "CURRENT_TIMESTAMP" }],
    ["mysql", "_utf8mb4\\'[]\\'", json, "DEFAULT_GENERATED", { kind: "expression", sql: "'[]'" }],
    ["mysql", null, varchar, "", undefined],
    // MariaDB prints SQL.
    ["mariadb", "'active'", varchar, "", { kind: "string", value: "active" }],
    ["mariadb", "'it''s'", varchar, "", { kind: "string", value: "it's" }],
    ["mariadb", "NULL", varchar, "", { kind: "null" }],
    ["mariadb", "current_timestamp()", timestamp, "", { kind: "expression", sql: "CURRENT_TIMESTAMP" }],
    // One function, three spellings.
    ["mysql", "now()", timestamp, "DEFAULT_GENERATED", { kind: "expression", sql: "CURRENT_TIMESTAMP" }],
    ["mysql", "CURRENT_TIMESTAMP(3)", timestamp, "DEFAULT_GENERATED", { kind: "expression", sql: "CURRENT_TIMESTAMP(3)" }],
    ["mariadb", "1", { kind: "boolean" }, "", { kind: "boolean", value: true }],
  ])("%s default %s", (flavor, raw, type, extra, expected) => {
    expect(parseMySqlDefault(raw, type, extra, flavor as any)).toEqual(expected);
  });
});

describe("SQLite types", () => {
  it.each<[string, CanonicalType]>([
    ["INTEGER", int4],
    ["BIGINT", { kind: "integer", bytes: 8, unsigned: false }],
    ["TEXT(255)", { kind: "string", fixed: false, length: 255 }],
    ["VARCHAR(36)", { kind: "string", fixed: false, length: 36 }],
    ["TEXT", { kind: "text", size: "unbounded" }],
    ["BOOLEAN", { kind: "boolean" }],
    ["DATETIME", { kind: "timestamp", zone: "local", precision: null }],
    ["DECIMAL(10,2)", { kind: "decimal", precision: 10, scale: 2 }],
    ["UNSIGNED BIG INT", { kind: "integer", bytes: 8, unsigned: false }],
    // Unknown names follow SQLite's affinity rules.
    ["LONG CHARS", { kind: "text", size: "unbounded" }],
    ["POINTS", { kind: "integer", bytes: 8, unsigned: false }],
    ["MONEY", { kind: "other", native: "MONEY" }],
    ["", { kind: "other", native: "" }],
  ])("%s", (native, expected) => {
    expect(sqliteTypes.parseType(native)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["'x'", { kind: "string", value: "x" }],
    ['"x"', { kind: "string", value: "x" }],
    ["0", { kind: "number", value: "0" }],
    ["TRUE", { kind: "boolean", value: true }],
    ["CURRENT_TIMESTAMP", { kind: "expression", sql: "CURRENT_TIMESTAMP" }],
    ["(datetime('now'))", { kind: "expression", sql: "datetime('now')" }],
    ["('(x)')", { kind: "string", value: "(x)" }],
  ])("default %s", (raw, expected) => {
    expect(parseSqliteDefault(raw)).toEqual(expected);
  });
});

describe("stripOuterParens", () => {
  it.each([
    ["((now()))", "now()"],
    ["(a) + (b)", "(a) + (b)"],
    ["('(')", "'('"],
    ["x", "x"],
  ])("%s → %s", (input, output) => {
    expect(stripOuterParens(input)).toBe(output);
  });
});

describe("PostgresCatalogReader", () => {
  const { fn, seen } = fakeCatalog([
    ["relkind IN", () => [{ table_name: "posts" }, { table_name: "users" }]],
    [
      "format_type",
      () => [
        { column_name: "id", type_text: "bigint", not_null: true, default_expr: null, type_name: "int8", type_kind: "b", is_identity: "YES", is_generated: "NEVER" },
        { column_name: "title", type_text: "character varying(200)", not_null: true, default_expr: "'untitled'::character varying", type_name: "varchar", type_kind: "b", is_identity: "NO", is_generated: "NEVER" },
        { column_name: "status", type_text: "post_status", not_null: true, default_expr: "'draft'::post_status", type_name: "post_status", type_kind: "e", enum_labels: ["draft", "live"], is_identity: "NO", is_generated: "NEVER" },
        { column_name: "tags", type_text: "post_status[]", not_null: false, default_expr: null, type_name: "_post_status", type_kind: "b", element_type_name: "post_status", element_type_kind: "e", enum_labels: "{draft,live}", is_identity: "NO", is_generated: "NEVER" },
        { column_name: "slug", type_text: "text", not_null: false, default_expr: "lower(title)", type_name: "text", type_kind: "b", is_identity: "NO", is_generated: "ALWAYS" },
        { column_name: "org_id", type_text: "integer", not_null: true, default_expr: null, type_name: "int4", type_kind: "b", is_identity: "NO", is_generated: "NEVER" },
        { column_name: "author_id", type_text: "integer", not_null: false, default_expr: null, type_name: "int4", type_kind: "b", is_identity: "NO", is_generated: "NEVER" },
      ],
    ],
    ["indisprimary ORDER BY k.ord", () => [{ column_name: "id" }]],
    [
      "contype = 'f'",
      () => [
        { constraint_name: "fk_author", column_name: "author_id", referenced_schema: "public", referenced_table: "users", referenced_column: "id", update_action: "a", delete_action: "n" },
        { constraint_name: "fk_org", column_name: "org_id", referenced_schema: "public", referenced_table: "memberships", referenced_column: "org_id", update_action: "c", delete_action: "r" },
        { constraint_name: "fk_org", column_name: "author_id", referenced_schema: "public", referenced_table: "memberships", referenced_column: "user_id", update_action: "c", delete_action: "r" },
      ],
    ],
    [
      "pg_am",
      () => [
        { index_name: "idx_title", is_unique: false, method: "btree", predicate: null, definition: "CREATE INDEX idx_title ON public.posts USING btree (title)", column_name: "title", quoted_name: "title", part_definition: "title" },
        { index_name: "idx_live", is_unique: false, method: "btree", predicate: "(status = 'live'::post_status)", definition: "…", column_name: "title", quoted_name: "title", part_definition: "title" },
        { index_name: "idx_lower", is_unique: true, method: "btree", predicate: null, definition: "…", column_name: null, quoted_name: null, part_definition: "lower((title)::text)" },
        { index_name: "idx_tags", is_unique: false, method: "gin", predicate: null, definition: "…", column_name: "tags", quoted_name: "tags", part_definition: "tags" },
        { index_name: "idx_desc", is_unique: false, method: "btree", predicate: null, definition: "…", column_name: "title", quoted_name: "title", part_definition: "title DESC" },
        { index_name: "idx_cover", is_unique: false, method: "btree", predicate: null, definition: "CREATE INDEX idx_cover ON public.posts USING btree (org_id) INCLUDE (title)", column_name: "org_id", quoted_name: "org_id", part_definition: "org_id" },
      ],
    ],
  ]);
  const reader = new PostgresCatalogReader(fn, "app");

  it("lists tables of the configured schema", async () => {
    expect(await reader.listTables()).toEqual(["posts", "users"]);
    expect(fn.mock.calls[0][0].values).toEqual(["app"]);
  });

  it("reads a table into the IR", async () => {
    const table = await reader.readTable("posts");
    const col = (name: string) => table.columns.find((c) => c.name === name)!;

    expect(col("id")).toMatchObject({ identity: true, nullable: false });
    expect(col("title")).toMatchObject({
      type: { kind: "string", fixed: false, length: 200 },
      default: { kind: "string", value: "untitled" },
    });
    expect(col("status").type).toEqual({ kind: "enum", values: ["draft", "live"], name: "post_status" });
    expect(col("tags").type).toEqual({
      kind: "array",
      element: { kind: "enum", values: ["draft", "live"], name: "post_status" },
    });
    expect(col("slug")).toMatchObject({ generatedExpression: "lower(title)" });
    expect(col("slug").default).toBeUndefined();
    expect(table.primaryKey).toEqual(["id"]);
  });

  it("pairs the columns of a composite foreign key and reads its actions", async () => {
    const table = await reader.readTable("posts");
    expect(table.foreignKeys).toEqual([
      { name: "fk_author", columns: ["author_id"], referencedTable: "users", referencedColumns: ["id"], referencedSchema: "public", onDelete: "SET NULL", onUpdate: "NO ACTION" },
      { name: "fk_org", columns: ["org_id", "author_id"], referencedTable: "memberships", referencedColumns: ["org_id", "user_id"], referencedSchema: "public", onDelete: "RESTRICT", onUpdate: "CASCADE" },
    ]);
  });

  it("says what each index has beyond plain columns", async () => {
    const table = await reader.readTable("posts");
    const idx = (name: string) => table.indexes.find((i) => i.name === name)!;
    expect(idx("idx_title")).toEqual({ name: "idx_title", unique: false, columns: ["title"], unsupported: [] });
    expect(idx("idx_live").unsupported).toEqual(["partial index WHERE (status = 'live'::post_status)"]);
    expect(idx("idx_lower").unsupported).toEqual(["expression lower((title)::text)"]);
    expect(idx("idx_tags").unsupported).toEqual(["USING gin"]);
    expect(idx("idx_desc").unsupported).toEqual(["key part title DESC"]);
    expect(idx("idx_cover").unsupported).toEqual(["INCLUDE (title)"]);
  });

  it("binds every table name instead of interpolating it", async () => {
    await reader.readTable("x'; DROP TABLE users; --");
    expect(seen.some((s) => s.includes("DROP TABLE"))).toBe(false);
  });
});

describe("MySqlCatalogReader", () => {
  function reader(version: string) {
    return fakeCatalog([
      ["SELECT VERSION()", () => [{ version }]],
      ["information_schema.TABLES", () => [{ table_name: "posts" }]],
      [
        "information_schema.COLUMNS",
        () => [
          { COLUMN_NAME: "id", COLUMN_TYPE: "int(10) unsigned", IS_NULLABLE: "NO", COLUMN_DEFAULT: null, EXTRA: "auto_increment" },
          { COLUMN_NAME: "title", COLUMN_TYPE: "varchar(200)", IS_NULLABLE: "NO", COLUMN_DEFAULT: version.includes("Maria") ? "'untitled'" : "untitled", EXTRA: "" },
          { COLUMN_NAME: "meta", COLUMN_TYPE: "longtext", IS_NULLABLE: "YES", COLUMN_DEFAULT: version.includes("Maria") ? "NULL" : null, EXTRA: "" },
          { COLUMN_NAME: "updated_at", COLUMN_TYPE: "timestamp", IS_NULLABLE: "NO", COLUMN_DEFAULT: "CURRENT_TIMESTAMP", EXTRA: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP" },
          { COLUMN_NAME: "total", COLUMN_TYPE: "int(11)", IS_NULLABLE: "YES", COLUMN_DEFAULT: null, EXTRA: "STORED GENERATED", GENERATION_EXPRESSION: "`id` * 2" },
        ],
      ],
      ["CHECK_CONSTRAINTS", () => [{ check_clause: "json_valid(`meta`)" }]],
      ["CONSTRAINT_NAME = 'PRIMARY'", () => [{ column_name: "id" }]],
      [
        "REFERENTIAL_CONSTRAINTS",
        () => [
          { constraint_name: "fk_a", column_name: "id", referenced_schema: "app", referenced_table: "users", referenced_column: "id", update_rule: "RESTRICT", delete_rule: "CASCADE", current_schema: "app" },
          { constraint_name: "fk_b", column_name: "title", referenced_schema: "other_db", referenced_table: "titles", referenced_column: "t", update_rule: "NO ACTION", delete_rule: "NO ACTION", current_schema: "app" },
        ],
      ],
      [
        "information_schema.STATISTICS",
        () => [
          { INDEX_NAME: "ft_title", NON_UNIQUE: 1, COLUMN_NAME: "title", SUB_PART: null, INDEX_TYPE: "FULLTEXT", COLLATION: null },
          { INDEX_NAME: "idx_prefix", NON_UNIQUE: 1, COLUMN_NAME: "title", SUB_PART: 10, INDEX_TYPE: "BTREE", COLLATION: "A" },
          { INDEX_NAME: "idx_fn", NON_UNIQUE: 1, COLUMN_NAME: null, SUB_PART: null, INDEX_TYPE: "BTREE", COLLATION: "A", EXPRESSION: "lower(`title`)" },
          { INDEX_NAME: "uq_title", NON_UNIQUE: "0", COLUMN_NAME: "title", SUB_PART: null, INDEX_TYPE: "BTREE", COLLATION: "A" },
        ],
      ],
    ]);
  }

  it("reads MySQL's bare literal defaults and flags", async () => {
    const { fn } = reader("8.0.36");
    const table = await new MySqlCatalogReader(fn).readTable("posts");
    const col = (name: string) => table.columns.find((c) => c.name === name)!;

    expect(col("id")).toMatchObject({ identity: true, type: { kind: "integer", unsigned: true } });
    expect(col("title").default).toEqual({ kind: "string", value: "untitled" });
    expect(col("meta").type).toEqual({ kind: "text", size: "long" });
    expect(col("updated_at")).toMatchObject({
      default: { kind: "expression", sql: "CURRENT_TIMESTAMP" },
      onUpdate: "CURRENT_TIMESTAMP",
    });
    expect(col("total")).toMatchObject({ generatedExpression: "`id` * 2" });
  });

  it("reads MariaDB's quoted defaults and json_valid() JSON columns", async () => {
    const { fn } = reader("10.11.6-MariaDB");
    const table = await new MySqlCatalogReader(fn).readTable("posts");
    const col = (name: string) => table.columns.find((c) => c.name === name)!;

    expect(col("title").default).toEqual({ kind: "string", value: "untitled" });
    expect(col("meta").type).toEqual({ kind: "json", binary: false });
    // NULL on a nullable column is no default at all.
    expect(col("meta").default).toBeUndefined();
  });

  it("reads referential actions, treating RESTRICT as InnoDB's NO ACTION", async () => {
    const { fn } = reader("8.0.36");
    const table = await new MySqlCatalogReader(fn).readTable("posts");
    expect(table.foreignKeys[0]).toMatchObject({ onDelete: "CASCADE", onUpdate: "NO ACTION" });
    expect(table.foreignKeys[1]).toMatchObject({ referencedSchema: "other_db" });
  });

  it("flags FULLTEXT, prefix and functional indexes", async () => {
    const { fn } = reader("8.0.36");
    const table = await new MySqlCatalogReader(fn).readTable("posts");
    const idx = (name: string) => table.indexes.find((i) => i.name === name)!;
    expect(idx("ft_title").unsupported).toEqual(["FULLTEXT"]);
    expect(idx("idx_prefix").unsupported).toEqual(["prefix length 10 on title"]);
    expect(idx("idx_fn").unsupported).toEqual(["expression lower(`title`)"]);
    expect(idx("uq_title")).toEqual({ name: "uq_title", unique: true, columns: ["title"], unsupported: [] });
  });

  it("lists base tables only", async () => {
    const { fn, seen } = reader("8.0.36");
    await new MySqlCatalogReader(fn).listTables();
    expect(seen[0]).toContain("TABLE_TYPE = 'BASE TABLE'");
  });

  it("resolves the server's capabilities from its version", async () => {
    const { fn } = reader("10.11.6-MariaDB");
    const info = await new MySqlCatalogReader(fn).readServerInfo();
    expect(info.capabilities).toMatchObject({ supportsNativeUuidType: true });
  });
});

describe("SqliteCatalogReader", () => {
  const { fn } = fakeCatalog([
    [/sqlite_master WHERE type = 'table' AND name NOT LIKE/, () => [{ table_name: "posts" }]],
    ["SELECT sql FROM sqlite_master", (values) => [{ sql: values[0] === "tags" ? "CREATE TABLE tags (id INTEGER PRIMARY KEY) WITHOUT ROWID" : "CREATE TABLE x (…)" }]],
    [
      'PRAGMA table_xinfo("posts")',
      () => [
        { cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
        { cid: 1, name: "title", type: "TEXT(200)", notnull: 1, dflt_value: "'untitled'", pk: 0, hidden: 0 },
        { cid: 2, name: "author_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
        { cid: 3, name: "slug", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 3 },
        { cid: 4, name: "created", type: "DATETIME", notnull: 1, dflt_value: "(datetime('now'))", pk: 0, hidden: 0 },
      ],
    ],
    ['PRAGMA table_xinfo("tags")', () => [{ cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1, hidden: 0 }]],
    [
      'PRAGMA foreign_key_list("posts")',
      () => [{ id: 0, seq: 0, table: "users", from: "author_id", to: null, on_update: "NO ACTION", on_delete: "CASCADE", match: "NONE" }],
    ],
    ['PRAGMA table_info("users")', () => [{ name: "uid", pk: 1 }]],
    [
      'PRAGMA index_list("posts")',
      () => [
        { seq: 0, name: "sqlite_autoindex_posts_1", unique: 1, origin: "u", partial: 0 },
        { seq: 1, name: "idx_live", unique: 0, origin: "c", partial: 1 },
        { seq: 2, name: "idx_lower", unique: 0, origin: "c", partial: 0 },
      ],
    ],
    ['PRAGMA index_xinfo("sqlite_autoindex_posts_1")', () => [{ seqno: 0, cid: 1, name: "title", desc: 0, coll: "BINARY", key: 1 }, { seqno: 1, cid: -1, name: null, desc: 0, coll: "BINARY", key: 0 }]],
    ['PRAGMA index_xinfo("idx_live")', () => [{ seqno: 0, cid: 1, name: "title", desc: 0, coll: "BINARY", key: 1 }]],
    ['PRAGMA index_xinfo("idx_lower")', () => [{ seqno: 0, cid: -2, name: null, desc: 0, coll: "BINARY", key: 1 }]],
  ]);
  const reader = new SqliteCatalogReader(fn);

  it("reads columns, the rowid alias and generated columns", async () => {
    const table = await reader.readTable("posts");
    const col = (name: string) => table.columns.find((c) => c.name === name)!;
    expect(col("id")).toMatchObject({ identity: true, nullable: false });
    expect(col("title")).toMatchObject({
      type: { kind: "string", fixed: false, length: 200 },
      default: { kind: "string", value: "untitled" },
    });
    expect(col("slug").generatedExpression).toBe("");
    expect(col("created").default).toEqual({ kind: "expression", sql: "datetime('now')" });
  });

  it("does not take a WITHOUT ROWID table's INTEGER key for a rowid alias", async () => {
    const table = await reader.readTable("tags");
    expect(table.columns[0].identity).toBe(false);
  });

  it("resolves a foreign key declared without a column list to the parent's key", async () => {
    const table = await reader.readTable("posts");
    expect(table.foreignKeys).toEqual([
      { columns: ["author_id"], referencedTable: "users", referencedColumns: ["uid"], onDelete: "CASCADE", onUpdate: "NO ACTION" },
    ]);
  });

  it("reads key columns only and flags partial and expression indexes", async () => {
    const table = await reader.readTable("posts");
    expect(table.indexes).toEqual([
      { name: "idx_live", unique: false, columns: ["title"], unsupported: ["partial index (WHERE clause)"] },
      { name: "idx_lower", unique: false, columns: [], unsupported: ["expression key part"] },
      { name: "sqlite_autoindex_posts_1", unique: true, columns: ["title"], unsupported: [] },
    ]);
  });

  it("refuses a table name that cannot be escaped into a PRAGMA", async () => {
    await expect(reader.readTable("bad\u0000name")).rejects.toThrow(/NUL/);
  });
});
