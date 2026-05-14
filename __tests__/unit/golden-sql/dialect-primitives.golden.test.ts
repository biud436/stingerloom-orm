import "reflect-metadata";
import { MySqlColumnDefinitionBuilder } from "../../../src/dialects/mysql/MySqlColumnDefinitionBuilder";
import { PostgresColumnDefinitionBuilder } from "../../../src/dialects/postgres/PostgresColumnDefinitionBuilder";
import { SqliteColumnDefinitionBuilder } from "../../../src/dialects/sqlite/SqliteColumnDefinitionBuilder";
import type { ColumnType } from "../../../src/decorators/Column";

/**
 * Golden — driver primitives: `castBuiltinType()` (ColumnType -> dialect
 * SQL type) and `wrapIdentifier()` (identifier escaping).
 *
 * These are the lowest-level dialect divergence points: a single map entry
 * changing here silently shifts every generated DDL column and every
 * escaped identifier. The table form keeps all three dialects' output
 * side by side so a diff shows exactly which cell moved.
 */

const mysql = new MySqlColumnDefinitionBuilder();
const postgres = new PostgresColumnDefinitionBuilder();
const sqlite = new SqliteColumnDefinitionBuilder();

describe("golden-sql / castBuiltinType — ColumnType to dialect SQL type", () => {
  // [ColumnType, postgres, mysql, sqlite]
  const matrix: ReadonlyArray<readonly [ColumnType, string, string, string]> = [
    ["varchar", "VARCHAR", "VARCHAR", "TEXT"],
    ["int", "INTEGER", "INT", "INTEGER"],
    ["number", "INTEGER", "INT", "INTEGER"],
    ["float", "REAL", "FLOAT", "REAL"],
    ["double", "NUMERIC($precision, $scale)", "DECIMAL($precision, $scale)", "REAL"],
    ["bigint", "BIGINT", "BIGINT", "INTEGER"],
    ["boolean", "BOOLEAN", "TINYINT($n)", "INTEGER"],
    ["datetime", "TIMESTAMP", "DATETIME", "TEXT"],
    ["timestamp", "TIMESTAMP", "TIMESTAMP", "TEXT"],
    ["timestamptz", "TIMESTAMPTZ", "DATETIME", "TEXT"],
    ["date", "DATE", "DATE", "TEXT"],
    ["text", "TEXT", "TEXT", "TEXT"],
    ["longtext", "TEXT", "LONGTEXT", "TEXT"],
    ["blob", "BYTEA", "BLOB", "BLOB"],
    ["char", "CHAR", "CHAR", "TEXT"],
    ["json", "JSON", "JSON", "TEXT"],
    ["jsonb", "JSONB", "JSON", "TEXT"],
    ["enum", "USER-DEFINED", "ENUM", "TEXT"],
    ["array", "ARRAY", "JSON", "TEXT"],
    // MySQL has no native UUID type under default capabilities — falls
    // back to a fixed-width CHAR.
    ["uuid", "UUID", "CHAR(36)", "VARCHAR(36)"],
  ];

  it.each(matrix)(
    "%s -> pg:%s / mysql:%s / sqlite:%s",
    (type, pgType, mysqlType, sqliteType) => {
      expect(postgres.castBuiltinType(type)).toBe(pgType);
      expect(mysql.castBuiltinType(type)).toBe(mysqlType);
      expect(sqlite.castBuiltinType(type)).toBe(sqliteType);
    },
  );
});

describe("golden-sql / wrapIdentifier — identifier escaping", () => {
  // [input, postgres, mysql, sqlite]
  const matrix: ReadonlyArray<readonly [string, string, string, string]> = [
    ["users", '"users"', "`users`", '"users"'],
    ["mixedCase", '"mixedCase"', "`mixedCase`", '"mixedCase"'],
    // Embedded double quote — doubled by PG/SQLite, untouched by MySQL.
    ['we"ird', '"we""ird"', '`we"ird`', '"we""ird"'],
    // Embedded backtick — doubled by MySQL, untouched by PG/SQLite.
    ["ba`ck", '"ba`ck"', "`ba``ck`", '"ba`ck"'],
  ];

  it.each(matrix)(
    "%s -> pg:%s / mysql:%s / sqlite:%s",
    (input, pgWrapped, mysqlWrapped, sqliteWrapped) => {
      expect(postgres.wrapIdentifier(input)).toBe(pgWrapped);
      expect(mysql.wrapIdentifier(input)).toBe(mysqlWrapped);
      expect(sqlite.wrapIdentifier(input)).toBe(sqliteWrapped);
    },
  );
});
