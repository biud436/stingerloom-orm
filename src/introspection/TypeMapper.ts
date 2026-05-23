import { ColumnType } from "../decorators/Column";

/**
 * Supported dialect for introspection type mapping.
 */
export type IntrospectionDialect = "mysql" | "postgres" | "sqlite";

/**
 * Reverse mapping from database-native column types to ORM ColumnType.
 *
 * Used by the introspection generator to produce correct @Column decorators
 * when generating entity files from an existing database schema.
 */
export class IntrospectionTypeMapper {
  private static readonly postgresMap: Record<string, ColumnType> = {
    // Numeric types
    INTEGER: "int",
    INT: "int",
    INT4: "int",
    SMALLINT: "int",
    BIGINT: "bigint",
    INT8: "bigint",
    SERIAL: "int",
    BIGSERIAL: "bigint",
    REAL: "float",
    FLOAT4: "float",
    "DOUBLE PRECISION": "double",
    FLOAT8: "double",
    NUMERIC: "double",
    DECIMAL: "double",

    // Boolean
    BOOLEAN: "boolean",
    BOOL: "boolean",

    // String types
    "CHARACTER VARYING": "varchar",
    VARCHAR: "varchar",
    TEXT: "text",
    CHARACTER: "char",
    CHAR: "char",
    BPCHAR: "char",

    // Date/time types
    "TIMESTAMP WITHOUT TIME ZONE": "timestamp",
    TIMESTAMP: "timestamp",
    "TIMESTAMP WITH TIME ZONE": "timestamptz",
    TIMESTAMPTZ: "timestamptz",
    DATE: "date",

    // JSON types
    JSON: "json",
    JSONB: "jsonb",

    // Binary
    BYTEA: "blob",

    // Array
    ARRAY: "array",

    // Enum (user-defined)
    "USER-DEFINED": "enum",
  };

  private static readonly sqliteMap: Record<string, ColumnType> = {
    // SQLite has flexible typing — the declared type drives the affinity.
    // Numeric types
    INTEGER: "int",
    INT: "int",
    "INT2": "int",
    "INT4": "int",
    "INT8": "bigint",
    MEDIUMINT: "int",
    SMALLINT: "int",
    TINYINT: "int",
    BIGINT: "bigint",
    "UNSIGNED BIG INT": "bigint",
    REAL: "float",
    FLOAT: "float",
    DOUBLE: "double",
    "DOUBLE PRECISION": "double",
    NUMERIC: "double",
    DECIMAL: "double",

    // Boolean (SQLite stores as 0/1 INTEGER but the declared type "BOOLEAN"
    // is honored)
    BOOLEAN: "boolean",
    BOOL: "boolean",

    // String types
    TEXT: "text",
    CLOB: "longtext",
    CHARACTER: "char",
    CHAR: "char",
    "NATIVE CHARACTER": "char",
    VARCHAR: "varchar",
    "VARYING CHARACTER": "varchar",
    NVARCHAR: "varchar",

    // Date/time
    DATETIME: "datetime",
    TIMESTAMP: "timestamp",
    DATE: "date",

    // JSON (declared type; SQLite stores as text)
    JSON: "json",

    // Binary
    BLOB: "blob",
  };

  private static readonly mysqlMap: Record<string, ColumnType> = {
    // Numeric types
    INT: "int",
    INTEGER: "int",
    MEDIUMINT: "int",
    SMALLINT: "int",
    TINYINT: "boolean",
    BIGINT: "bigint",
    FLOAT: "float",
    DOUBLE: "double",
    DECIMAL: "double",
    NUMERIC: "double",

    // Boolean (MySQL TINYINT(1) is typically boolean)
    // Note: TINYINT is mapped to boolean above

    // String types
    VARCHAR: "varchar",
    CHAR: "char",
    TEXT: "text",
    MEDIUMTEXT: "text",
    LONGTEXT: "longtext",
    TINYTEXT: "text",

    // Date/time types
    DATETIME: "datetime",
    TIMESTAMP: "timestamp",
    DATE: "date",

    // JSON
    JSON: "json",

    // Binary
    BLOB: "blob",
    MEDIUMBLOB: "blob",
    LONGBLOB: "blob",
    TINYBLOB: "blob",

    // Enum
    ENUM: "enum",
  };

  /**
   * Map a database column type string to the corresponding ORM ColumnType.
   *
   * @param dbType - The raw database type string (e.g. "VARCHAR", "INTEGER")
   * @param dialect - The database dialect ("mysql" or "postgres")
   * @param columnTypeFull - Optional full column type with width/length, e.g.
   *   "tinyint(1)", "tinyint(4) unsigned", "varchar(255)". Used to refine
   *   MySQL TINYINT detection: only TINYINT(1) is treated as boolean; wider
   *   TINYINT(N) widths are treated as small integers.
   * @returns The mapped ColumnType, or "varchar" as a fallback for unknown types
   */
  static toColumnType(
    dbType: string,
    dialect: IntrospectionDialect,
    columnTypeFull?: string,
  ): ColumnType {
    const normalized = dbType.toUpperCase().trim();

    if (dialect === "sqlite") {
      // SQLite reports declared types verbatim; strip parens like
      // `VARCHAR(255)` → `VARCHAR` so the map lookup still works.
      const stripped = normalized.replace(/\s*\([^)]*\)/, "").trim();
      return this.sqliteMap[stripped] ?? "varchar";
    }

    if (dialect === "mysql" && normalized === "TINYINT") {
      // TINYINT(1) is the conventional MySQL boolean. Wider widths
      // (TINYINT(3), TINYINT(4) unsigned, etc.) are small integers. When
      // the full column type isn't available, fall back to the legacy
      // mapping (boolean) for backwards compatibility.
      const full = (columnTypeFull ?? "").toLowerCase();
      if (!full) return "boolean";
      const widthMatch = full.match(/tinyint\((\d+)\)/);
      const width = widthMatch ? Number(widthMatch[1]) : null;
      if (width === 1) return "boolean";
      return "int";
    }

    const map = dialect === "mysql" ? this.mysqlMap : this.postgresMap;
    return map[normalized] ?? "varchar";
  }

  /**
   * Parse a SQLite declared type's parenthesized width, e.g. `VARCHAR(255)`
   * → `255` or `DECIMAL(10,2)` → `10`. Returns `null` when there is no
   * width or the width isn't a positive integer.
   */
  static parseSqliteWidth(declaredType: string | null | undefined): number | null {
    if (!declaredType) return null;
    const match = declaredType.match(/\((\d+)(?:\s*,\s*\d+)?\)/);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Parse a SQLite declared type's `(precision, scale)`, e.g. `DECIMAL(10,2)`
   * → `{ precision: 10, scale: 2 }`. Returns `null` when there are no
   * comma-separated numeric arguments.
   */
  static parseSqlitePrecisionScale(
    declaredType: string | null | undefined,
  ): { precision: number; scale: number } | null {
    if (!declaredType) return null;
    const match = declaredType.match(/\((\d+)\s*,\s*(\d+)\)/);
    if (!match) return null;
    const precision = Number(match[1]);
    const scale = Number(match[2]);
    if (!Number.isFinite(precision) || !Number.isFinite(scale)) return null;
    return { precision, scale };
  }

  /**
   * Map a ColumnType to a TypeScript type string.
   */
  static toTsType(columnType: ColumnType): string {
    switch (columnType) {
      case "int":
      case "float":
      case "double":
      case "bigint":
        return "number";
      case "boolean":
        return "boolean";
      case "json":
      case "jsonb":
      case "array":
        return "any";
      case "blob":
        return "Buffer";
      case "datetime":
      case "timestamp":
      case "timestamptz":
      case "date":
        return "Date";
      default:
        return "string";
    }
  }
}
