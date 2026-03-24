import { ColumnType } from "../decorators/Column";

/**
 * Supported dialect for introspection type mapping.
 */
export type IntrospectionDialect = "mysql" | "postgres";

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
   * @returns The mapped ColumnType, or "varchar" as a fallback for unknown types
   */
  static toColumnType(dbType: string, dialect: IntrospectionDialect): ColumnType {
    const normalized = dbType.toUpperCase().trim();
    const map = dialect === "mysql" ? this.mysqlMap : this.postgresMap;
    return map[normalized] ?? "varchar";
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
