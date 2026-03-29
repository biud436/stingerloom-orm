import { ColumnOption, ColumnType } from "../../decorators/Column";
import { ColumnDefContext } from "../ColumnDefinitionBuilder";
import { BaseColumnDefinitionBuilder } from "../BaseColumnDefinitionBuilder";
import { Exception } from "../../errors";

/**
 * PostgreSQL dialect column definition builder.
 *
 * - Boolean: native BOOLEAN
 * - Enum: "schema"."enumName" (schema-qualified custom type)
 * - Decimal: NUMERIC($p,$s), max precision 1000
 * - Auto-increment: SERIAL (early return)
 * - UUID PK: DEFAULT gen_random_uuid() (early return)
 * - Identifier quoting: double quote (")
 */
export class PostgresColumnDefinitionBuilder extends BaseColumnDefinitionBuilder {
  readonly defaultColumnOption: ColumnOption = {
    type: "varchar",
    length: 255,
    nullable: false,
  };

  private readonly schema: string;

  constructor(schema: string = "public") {
    super();
    this.schema = schema;
  }

  castType(type: ColumnType): string {
    switch (type) {
      case "varchar":
        return "VARCHAR";
      case "int":
      case "number":
        return "INTEGER";
      case "boolean":
        return "BOOLEAN";
      case "datetime":
      case "timestamp":
        return "TIMESTAMP";
      case "timestamptz":
        return "TIMESTAMPTZ";
      case "date":
        return "DATE";
      case "float":
        return "REAL";
      case "double":
        return "NUMERIC($precision, $scale)";
      case "blob":
        return "BYTEA";
      case "text":
      case "longtext":
        return "TEXT";
      case "bigint":
        return "BIGINT";
      case "json":
        return "JSON";
      case "jsonb":
        return "JSONB";
      case "char":
        return "CHAR";
      case "enum":
        return "USER-DEFINED";
      case "array":
        return "ARRAY";
      case "uuid":
        return "UUID";
      default:
        return type as string;
    }
  }

  wrapIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Returns a schema-qualified identifier in `"schema"."name"` format.
   */
  private wrapQualified(name: string): string {
    return `${this.wrapIdentifier(this.schema)}.${this.wrapIdentifier(name)}`;
  }

  protected resolveEnumType(
    type: string,
    option: ColumnOption,
    ctx: ColumnDefContext,
  ): string {
    if (option.type === "enum") {
      const resolvedEnumName =
        option.enumName ?? `${ctx.tableName}_${ctx.columnName}_enum`;
      return this.wrapQualified(resolvedEnumName);
    }
    return type;
  }

  protected resolveDecimalType(type: string, option: ColumnOption): string {
    if (!type.startsWith("NUMERIC")) return type;

    if (option.precision !== undefined && option.precision > 1000) {
      throw new Exception(
        "PostgreSQL NUMERIC precision must be 1000 or less.",
        400,
      );
    }

    type = type.replace("$precision", option.precision?.toString() ?? "10");
    type = type.replace("$scale", option.scale?.toString() ?? "2");
    return type;
  }

  protected buildAutoIncrement(
    option: ColumnOption,
    ctx: ColumnDefContext,
  ): string | null {
    if (!option.autoIncrement) return null;

    const nullable = option.nullable ? "NULL" : "NOT NULL";
    const pk = option.primary && !ctx.isCompositePk ? " PRIMARY KEY" : "";
    return `${this.wrapIdentifier(ctx.columnName)} SERIAL ${nullable}${pk}`;
  }

  protected buildUuidPk(
    option: ColumnOption,
    ctx: ColumnDefContext,
  ): string | null {
    if (option.type === "uuid" && option.generationStrategy === "uuid") {
      const nullable = option.nullable ? "NULL" : "NOT NULL";
      const pk = option.primary && !ctx.isCompositePk ? " PRIMARY KEY" : "";
      return `${this.wrapIdentifier(ctx.columnName)} UUID ${nullable} DEFAULT gen_random_uuid()${pk}`;
    }
    return null;
  }

  protected isFixedSizeType(option: ColumnOption): boolean {
    return option.type === "uuid";
  }
}
