import { ColumnOption, ColumnType } from "../../decorators/Column";
import { ColumnDefContext } from "../ColumnDefinitionBuilder";
import { BaseColumnDefinitionBuilder } from "../BaseColumnDefinitionBuilder";
import { ALL_SQLITE } from "../DialectCapabilities";
import type { SqliteCapabilities, CommonCapabilities } from "../DialectCapabilities";
import type { DialectName } from "../../core/ColumnTypeRegistry";

/**
 * SQLite dialect column definition builder.
 *
 * - Boolean: INTEGER
 * - Enum: TEXT (no native enum support)
 * - Decimal: REAL (no native decimal support)
 * - Auto-increment: INTEGER PRIMARY KEY AUTOINCREMENT (early return)
 * - Identifier quoting: double quote (")
 */
export class SqliteColumnDefinitionBuilder extends BaseColumnDefinitionBuilder {
  protected readonly dialectName: DialectName = "sqlite";

  constructor(capabilities?: SqliteCapabilities | CommonCapabilities) {
    super(capabilities ?? ALL_SQLITE);
  }
  readonly defaultColumnOption: ColumnOption = {
    type: "varchar",
    length: 255,
    nullable: false,
  };

  /**
   * SQLite carries generated-column support (3.31+) on its dialect-specific
   * flag — the common `supportsGeneratedColumns` is false in its version
   * feature table.
   */
  protected supportsGeneratedColumns(): boolean {
    const caps = this.capabilities as SqliteCapabilities;
    return (
      caps.supportsSqliteGeneratedColumns ?? caps.supportsGeneratedColumns
    );
  }

  castBuiltinType(type: ColumnType): string {
    switch (type) {
      case "varchar":
      case "text":
      case "longtext":
      case "char":
      case "enum":
      case "json":
      case "jsonb":
      case "array":
      case "datetime":
      case "date":
      case "timestamp":
      case "timestamptz":
        return "TEXT";
      case "int":
      case "number":
      case "boolean":
      case "bigint":
        return "INTEGER";
      case "float":
      case "double":
        return "REAL";
      case "blob":
        return "BLOB";
      case "uuid":
        return "VARCHAR(36)";
      default:
        return type as string;
    }
  }

  wrapIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  protected resolveBooleanType(type: string, option: ColumnOption): string {
    if (option.type === "boolean") {
      return "INTEGER";
    }
    return type;
  }

  protected buildAutoIncrement(
    option: ColumnOption,
    ctx: ColumnDefContext,
  ): string | null {
    if (!option.autoIncrement) return null;
    return `${this.wrapIdentifier(ctx.columnName)} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }

  protected needsLength(type: string): boolean {
    return ["TEXT", "VARCHAR", "CHAR"].some((t) =>
      type.toUpperCase().startsWith(t),
    );
  }

  protected buildLengthSuffix(type: string, option: ColumnOption): string {
    const alreadyHasParens = type.includes("(");
    if (alreadyHasParens || !option.length) return type;
    // SQLite casts many source types to TEXT; check the user's intent
    // (option.type) rather than the cast output so a date/json column
    // doesn't inherit varchar's length default via TEXT(255).
    const userType = option.type;
    const acceptsLength =
      userType === "varchar" || userType === "char" || userType === "text";
    if (acceptsLength && this.needsLength(type)) {
      return `${type}(${option.length})`;
    }
    return type;
  }
}
