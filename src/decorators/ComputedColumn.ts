/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ColumnType } from "./Column";

export const COMPUTED_COLUMN_TOKEN = Symbol.for("STG_COMPUTED_COLUMN");

/**
 * Options for a database-level computed/generated column.
 *
 * @example
 * ```ts
 * @ComputedColumn({
 *   expression: "first_name || ' ' || last_name",
 *   stored: true,
 * })
 * fullName: string;
 * ```
 */
export interface ComputedColumnOption {
  /** SQL expression for the generated column. */
  expression: string;
  /** Whether the column is STORED (persisted) or VIRTUAL. Default: false (VIRTUAL). */
  stored?: boolean;
  /** Explicit column type. If omitted, the DB infers it from the expression. */
  type?: ColumnType;
  /** Column length (for VARCHAR etc.). */
  length?: number;
  /** Whether the column is nullable. Default: true. */
  nullable?: boolean;
}

export interface ComputedColumnMetadata {
  propertyKey: string;
  name: string;
  options: ComputedColumnOption;
}

/**
 * Marks a property as a database-level generated/computed column.
 *
 * The column is automatically excluded from INSERT and UPDATE statements.
 * DDL: `GENERATED ALWAYS AS (expression) STORED|VIRTUAL`
 *
 * Supported on PostgreSQL 12+, MySQL 5.7+, and SQLite.
 */
export function ComputedColumn(option: ComputedColumnOption): PropertyDecorator {
  return (target: any, propertyKey: string | symbol) => {
    const key = propertyKey.toString();
    const metadata: ComputedColumnMetadata = {
      propertyKey: key,
      name: key,
      options: option,
    };
    const existing: ComputedColumnMetadata[] =
      Reflect.getMetadata(COMPUTED_COLUMN_TOKEN, target) ?? [];
    Reflect.defineMetadata(COMPUTED_COLUMN_TOKEN, [...existing, metadata], target);
  };
}
