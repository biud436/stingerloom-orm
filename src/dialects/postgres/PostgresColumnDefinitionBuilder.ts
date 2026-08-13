import { ColumnOption, ColumnType } from "../../decorators/Column";
import { ColumnDefContext } from "../ColumnDefinitionBuilder";
import { BaseColumnDefinitionBuilder } from "../BaseColumnDefinitionBuilder";
import { Exception } from "../../errors";
import { ALL_POSTGRES } from "../DialectCapabilities";
import type { PostgresCapabilities, CommonCapabilities } from "../DialectCapabilities";
import type { DialectName } from "../../core/ColumnTypeRegistry";

/**
 * PostgreSQL dialect column definition builder.
 *
 * - Boolean: native BOOLEAN
 * - Enum: "schema"."enumName" (schema-qualified custom type)
 * - Decimal: NUMERIC($p,$s), max precision 1000
 * - Auto-increment: SERIAL, or BIGSERIAL for bigint columns (early return)
 * - UUID PK: DEFAULT gen_random_uuid() (PG 13+) or uuid_generate_v4() (pgcrypto)
 * - Identifier quoting: double quote (")
 */
export class PostgresColumnDefinitionBuilder extends BaseColumnDefinitionBuilder {
  protected readonly dialectName: DialectName = "postgres";

  readonly defaultColumnOption: ColumnOption = {
    type: "varchar",
    length: 255,
    nullable: false,
  };

  private readonly schema: string;

  constructor(schema: string = "public", capabilities?: PostgresCapabilities | CommonCapabilities) {
    super(capabilities ?? ALL_POSTGRES);
    this.schema = schema;
  }

  /** Access PostgreSQL-specific capabilities with proper typing. */
  private get pg(): PostgresCapabilities {
    return this.capabilities as PostgresCapabilities;
  }

  castBuiltinType(type: ColumnType): string {
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

    // BIGSERIAL for bigint PKs — a plain SERIAL is int4 and overflows at ~2.1B rows.
    const serialType = option.type === "bigint" ? "BIGSERIAL" : "SERIAL";
    const nullable = option.nullable ? "NULL" : "NOT NULL";
    const pk = option.primary && !ctx.isCompositePk ? " PRIMARY KEY" : "";
    return `${this.wrapIdentifier(ctx.columnName)} ${serialType} ${nullable}${pk}`;
  }

  protected buildUuidPk(
    option: ColumnOption,
    ctx: ColumnDefContext,
  ): string | null {
    if (option.type === "uuid" && option.generationStrategy === "uuid") {
      const nullable = option.nullable ? "NULL" : "NOT NULL";
      const pk = option.primary && !ctx.isCompositePk ? " PRIMARY KEY" : "";
      // PG 13+: gen_random_uuid() is built-in
      // PG < 13: requires pgcrypto extension for uuid_generate_v4()
      const defaultExpr = this.pg.supportsNativeGenRandomUuid
        ? "gen_random_uuid()"
        : "uuid_generate_v4()";
      return `${this.wrapIdentifier(ctx.columnName)} UUID ${nullable} DEFAULT ${defaultExpr}${pk}`;
    }
    return null;
  }

  protected isFixedSizeType(option: ColumnOption): boolean {
    return option.type === "uuid";
  }
}
