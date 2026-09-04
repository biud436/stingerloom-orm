import { ColumnOption, ColumnType } from "../decorators/Column";
import type { ComputedColumnMetadata } from "../decorators/ComputedColumn";
import { MySqlColumnDefinitionBuilder } from "./mysql/MySqlColumnDefinitionBuilder";
import { PostgresColumnDefinitionBuilder } from "./postgres/PostgresColumnDefinitionBuilder";
import { SqliteColumnDefinitionBuilder } from "./sqlite/SqliteColumnDefinitionBuilder";
import type { CommonCapabilities } from "./DialectCapabilities";

/**
 * Context required when building a column definition.
 */
export interface ColumnDefContext {
  /** Column name (resolved from metadata). */
  columnName: string;
  /** Table name (needed for enum naming, etc.). */
  tableName: string;
  /** Whether this table uses a composite primary key. */
  isCompositePk?: boolean;
}

/**
 * Strategy interface for building dialect-specific column definition SQL fragments.
 *
 * Each dialect provides its own implementation that encapsulates type casting,
 * boolean/enum/decimal handling, auto-increment, and identifier quoting differences.
 */
export interface ColumnDefinitionBuilder {
  /**
   * Default ColumnOption applied when column.options is undefined.
   */
  readonly defaultColumnOption: ColumnOption;
  /**
   * Builds a complete column definition SQL fragment.
   * Example: `"id" SERIAL NOT NULL PRIMARY KEY`
   */
  buildColumnDef(option: ColumnOption, ctx: ColumnDefContext): string;

  /**
   * Builds a `@ComputedColumn` (generated column) definition SQL fragment.
   * Example: `"total" INTEGER GENERATED ALWAYS AS (qty * price) VIRTUAL`
   *
   * This is the single source of truth for generated-column DDL — both the
   * migration-time SchemaGenerator and the runtime synchronize path
   * (driver `createTable()` / SchemaDiff ADD COLUMN) render through it, so
   * expression resolution and the STORED/VIRTUAL decision can never diverge.
   *
   * Dialect notes: PostgreSQL only supports STORED, so a VIRTUAL request is
   * coerced (with a warning when `stored: false` was explicit). Throws when
   * the connected server version does not support generated columns at all.
   */
  buildComputedColumnDef(
    column: ComputedColumnMetadata,
    ctx: ColumnDefContext,
  ): string;

  /**
   * Converts an abstract ColumnType to a dialect-specific SQL type string.
   */
  castType(type: ColumnType): string;

  /**
   * Wraps an identifier with dialect-appropriate quoting.
   */
  wrapIdentifier(name: string): string;
}

export type ColumnDefinitionDialect = "mysql" | "postgres" | "sqlite";

/**
 * Creates a ColumnDefinitionBuilder instance for the given dialect.
 */
export function createColumnDefinitionBuilder(
  dialect: ColumnDefinitionDialect,
  schema?: string,
  capabilities?: CommonCapabilities,
): ColumnDefinitionBuilder {
  switch (dialect) {
    case "mysql":
      return new MySqlColumnDefinitionBuilder(capabilities);
    case "postgres":
      return new PostgresColumnDefinitionBuilder(schema ?? "public", capabilities);
    case "sqlite":
      return new SqliteColumnDefinitionBuilder(capabilities);
  }
}
