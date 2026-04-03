import { ColumnOption, ColumnType } from "../../decorators/Column";
import { ColumnDefContext } from "../ColumnDefinitionBuilder";
import { BaseColumnDefinitionBuilder } from "../BaseColumnDefinitionBuilder";
import { Exception } from "../../errors";
import { ALL_MYSQL } from "../DialectCapabilities";
import type { MySqlCapabilities, CommonCapabilities } from "../DialectCapabilities";

/**
 * MySQL dialect column definition builder.
 *
 * - Boolean: TINYINT(1)
 * - Enum: inline ENUM('a','b')
 * - Decimal: DECIMAL($p,$s), max precision 65
 * - Auto-increment: suffix `AUTO_INCREMENT`
 * - Identifier quoting: backtick (`)
 */
export class MySqlColumnDefinitionBuilder extends BaseColumnDefinitionBuilder {
  constructor(capabilities?: MySqlCapabilities | CommonCapabilities) {
    super(capabilities ?? ALL_MYSQL);
  }

  /** Access MySQL-specific capabilities with proper typing. */
  private get mysql(): MySqlCapabilities {
    return this.capabilities as MySqlCapabilities;
  }
  readonly defaultColumnOption: ColumnOption = {
    type: "varchar",
    length: 255,
    nullable: false,
  };

  castType(type: ColumnType): string {
    switch (type) {
      case "varchar":
        return "VARCHAR";
      case "int":
      case "number":
        return "INT";
      case "boolean":
        return "TINYINT($n)";
      case "datetime":
        return "DATETIME";
      case "date":
        return "DATE";
      case "timestamp":
        return "TIMESTAMP";
      case "timestamptz":
        return "DATETIME";
      case "float":
        return "FLOAT";
      case "double":
        return "DECIMAL($precision, $scale)";
      case "blob":
        return "BLOB";
      case "text":
        return "TEXT";
      case "longtext":
        return "LONGTEXT";
      case "bigint":
        return "BIGINT";
      case "json":
      case "jsonb":
      case "array":
        return this.mysql.supportsJsonColumnType ? "JSON" : "LONGTEXT";
      case "char":
        return "CHAR";
      case "enum":
        return "ENUM";
      case "uuid":
        return "CHAR(36)";
      default:
        return type as string;
    }
  }

  wrapIdentifier(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  protected resolveBooleanType(type: string, option: ColumnOption): string {
    if (option.type === "boolean") {
      return type.replace("$n", option.length?.toString() ?? "1");
    }
    return type;
  }

  protected resolveEnumType(
    type: string,
    option: ColumnOption,
    _ctx: ColumnDefContext,
  ): string {
    if (
      option.type === "enum" &&
      option.enumValues &&
      option.enumValues.length > 0
    ) {
      const values = option.enumValues
        .map((v: string) => `'${v.replace(/'/g, "''")}'`)
        .join(",");
      return `ENUM(${values})`;
    }
    return type;
  }

  protected resolveDecimalType(type: string, option: ColumnOption): string {
    if (!type.startsWith("DECIMAL")) return type;

    if (option.precision !== undefined && option.precision > 65) {
      throw new Exception(
        "MySQL DECIMAL precision must be 65 or less.",
        400,
      );
    }

    type = type.replace("$precision", option.precision?.toString() ?? "10");
    type = type.replace("$scale", option.scale?.toString() ?? "2");
    return type;
  }

  protected buildAutoIncrementSuffix(option: ColumnOption): string {
    return option.autoIncrement ? " AUTO_INCREMENT" : "";
  }

  protected needsLength(type: string): boolean {
    return !type.includes("(") && !!type;
  }

  protected buildLengthSuffix(type: string, option: ColumnOption): string {
    const alreadyHasParens = type.includes("(");
    if (alreadyHasParens || !option.length) return type;
    return `${type}(${option.length})`;
  }

  protected renderBooleanDefault(value: boolean): string {
    return ` DEFAULT ${value ? "1" : "0"}`;
  }
}
