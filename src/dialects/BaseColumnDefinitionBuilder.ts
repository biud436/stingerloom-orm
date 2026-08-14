import { ColumnOption, ColumnType } from "../decorators/Column";
import { ColumnDefinitionBuilder, ColumnDefContext } from "./ColumnDefinitionBuilder";
import { CommonCapabilities, ALL_COMMON } from "./DialectCapabilities";
import { ColumnTypeRegistry, DialectName } from "../core/ColumnTypeRegistry";

/**
 * Abstract base class for column definition builders.
 *
 * Uses the Template Method pattern to define the algorithmic skeleton of
 * column definition building, deferring dialect-specific steps to subclasses.
 */
export abstract class BaseColumnDefinitionBuilder
  implements ColumnDefinitionBuilder
{
  abstract readonly defaultColumnOption: ColumnOption;
  readonly capabilities: CommonCapabilities;

  /** The dialect name used to look up custom column types from the registry. */
  protected abstract readonly dialectName: DialectName;

  constructor(capabilities?: CommonCapabilities) {
    this.capabilities = capabilities ?? ALL_COMMON;
  }

  abstract castBuiltinType(type: string): string;
  abstract wrapIdentifier(name: string): string;

  /**
   * Converts a ColumnType to the dialect-specific SQL type string.
   * First checks the ColumnTypeRegistry for custom types, then falls back
   * to the dialect's built-in type mapping.
   */
  castType(type: ColumnType): string {
    const registry = ColumnTypeRegistry.getInstance();
    const custom = registry.resolve(type, this.dialectName);
    if (custom !== undefined) return custom;
    return this.castBuiltinType(type);
  }

  /**
   * Builds a complete column definition SQL fragment.
   */
  buildColumnDef(option: ColumnOption, ctx: ColumnDefContext): string {
    let type = this.castType(option.type ?? "varchar");

    // 1. Resolve boolean type
    type = this.resolveBooleanType(type, option);

    // 2. Resolve enum type
    type = this.resolveEnumType(type, option, ctx);

    // 3. Resolve decimal/numeric type (with precision validation)
    type = this.resolveDecimalType(type, option);

    // 3.5. Resolve array type (PostgreSQL emits `element[]` instead of the
    // bare `ARRAY` placeholder, which is not valid DDL)
    type = this.resolveArrayType(type, option, ctx);

    // 4. Auto-increment early return
    const autoIncResult = this.buildAutoIncrement(option, ctx);
    if (autoIncResult !== null) {
      return autoIncResult;
    }

    // 5. UUID PK with generation strategy early return
    const uuidResult = this.buildUuidPk(option, ctx);
    if (uuidResult !== null) {
      return uuidResult;
    }

    // 6. Length suffix
    const typeWithLength = this.buildLengthSuffix(type, option);

    // 7. Final assembly
    const nullable = option.nullable ? "NULL" : "NOT NULL";
    const pk =
      option.primary && !ctx.isCompositePk ? " PRIMARY KEY" : "";
    const autoIncSuffix = this.buildAutoIncrementSuffix(option);
    const defaultClause = this.renderDefaultClause(option.default);

    return `${this.wrapIdentifier(ctx.columnName)} ${typeWithLength} ${nullable}${defaultClause}${pk}${autoIncSuffix}`;
  }

  /**
   * Resolves the boolean type for this dialect.
   * Default: no change (e.g. PostgreSQL native BOOLEAN).
   */
  protected resolveBooleanType(type: string, _option: ColumnOption): string {
    return type;
  }

  /**
   * Resolves the enum type for this dialect.
   * Default: no change.
   */
  protected resolveEnumType(
    type: string,
    _option: ColumnOption,
    _ctx: ColumnDefContext,
  ): string {
    return type;
  }

  /**
   * Replaces $precision/$scale placeholders in decimal/numeric types.
   * Default: substitute placeholders with option values or defaults (10, 2).
   */
  protected resolveDecimalType(type: string, option: ColumnOption): string {
    if (!type.includes("$precision")) return type;
    type = type.replace("$precision", option.precision?.toString() ?? "10");
    type = type.replace("$scale", option.scale?.toString() ?? "2");
    return type;
  }

  /**
   * Resolves the array type for this dialect.
   * Default: no change (MySQL/SQLite store arrays as JSON/TEXT, so their
   * castBuiltinType mapping is already final).
   */
  protected resolveArrayType(
    type: string,
    _option: ColumnOption,
    _ctx: ColumnDefContext,
  ): string {
    return type;
  }

  /**
   * Builds an auto-increment column definition.
   * Returns the full definition string for early return, or null to continue
   * with the normal flow (auto-increment handled as a suffix).
   *
   * Default: null (auto-increment handled via suffix).
   */
  protected buildAutoIncrement(
    _option: ColumnOption,
    _ctx: ColumnDefContext,
  ): string | null {
    return null;
  }

  /**
   * Builds a UUID PK column definition with generation strategy.
   * Default: null (no special handling needed for most dialects).
   */
  protected buildUuidPk(
    _option: ColumnOption,
    _ctx: ColumnDefContext,
  ): string | null {
    return null;
  }

  /**
   * Returns an auto-increment suffix (e.g. MySQL's ` AUTO_INCREMENT`).
   * Default: empty string.
   */
  protected buildAutoIncrementSuffix(_option: ColumnOption): string {
    return "";
  }

  /**
   * Appends a length suffix to the type.
   * Default: only for VARCHAR, CHAR, etc.
   */
  protected buildLengthSuffix(type: string, option: ColumnOption): string {
    const alreadyHasParens = type.includes("(");
    const isFixedSizeType = this.isFixedSizeType(option);
    if (alreadyHasParens || isFixedSizeType || !option.length) return type;

    if (this.needsLength(type)) {
      return `${type}(${option.length})`;
    }
    return type;
  }

  /**
   * Whether this type requires a length parameter.
   * Default: VARCHAR, CHAR.
   */
  protected needsLength(type: string): boolean {
    return ["VARCHAR", "CHAR"].some((t) => type.toUpperCase().startsWith(t));
  }

  /**
   * Whether this is a fixed-size type that does not accept a length parameter.
   * Default: false.
   */
  protected isFixedSizeType(_option: ColumnOption): boolean {
    return false;
  }

  /**
   * Renders the DEFAULT clause.
   * Parenthesized values are treated as raw SQL expressions.
   */
  protected renderDefaultClause(
    value: string | number | boolean | null | undefined,
  ): string {
    if (value === undefined) return "";
    if (value === null) return " DEFAULT NULL";
    if (typeof value === "number") return ` DEFAULT ${value}`;
    if (typeof value === "boolean") {
      return this.renderBooleanDefault(value);
    }
    // Parenthesized string → raw SQL expression
    if (
      typeof value === "string" &&
      value.startsWith("(") &&
      value.endsWith(")")
    ) {
      return ` DEFAULT ${value}`;
    }
    // String literal — escape single quotes
    return ` DEFAULT '${value.replace(/'/g, "''")}'`;
  }

  /**
   * Renders a boolean DEFAULT value.
   * Default: TRUE/FALSE (PostgreSQL/SQLite).
   */
  protected renderBooleanDefault(value: boolean): string {
    return ` DEFAULT ${value ? "TRUE" : "FALSE"}`;
  }
}
