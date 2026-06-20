/* eslint-disable @typescript-eslint/no-explicit-any */
import { ColumnType } from "./Column";
import { Logger } from "../utils/Logger";
import type { ComputedColumnExpressionBuilder } from "../core/expressions/ComputedColumnExpression";

const logger = new Logger("ComputedColumn");

export type { ComputedColumnExpressionBuilder };
export type { ComputedColumnExpressionContext } from "../core/expressions/ComputedColumnExpression";

export const COMPUTED_COLUMN_TOKEN = Symbol.for("STG_COMPUTED_COLUMN");

/**
 * Options for a database-level computed/generated column.
 *
 * @example
 * ```ts
 * // Literal string form.
 * @ComputedColumn({
 *   expression: "first_name || ' ' || last_name",
 *   stored: true,
 * })
 * fullName: string;
 *
 * // Dialect-portable builder form — one definition, correct DDL on every
 * // driver, no `process.env` access.
 * @ComputedColumn({
 *   expression: (e) =>
 *     e.dateDiff(e.col("completed_at"), e.col("created_at"), "hour"),
 *   type: "int",
 * })
 * cycleTimeHours: number;
 * ```
 */
export interface ComputedColumnOption {
  /**
   * SQL expression for the generated column. Either:
   *  - a **literal SQL string** — embedded verbatim into the DDL, so it must
   *    already be valid for the target dialect, or
   *  - a **builder function** `(e) => …` using the dialect-portable
   *    Expressions DSL (`e.iff`, `e.col`, `e.dateDiff`, …). The builder is
   *    invoked once per connection at schema-generation time and renders
   *    dialect-correct SQL — prefer it over hand-written dialect strings.
   */
  expression: string | ComputedColumnExpressionBuilder;
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
 * Heuristic nudge toward the builder form — warns once when a literal
 * expression mixes MySQL and PostgreSQL function names, which is a sign the
 * caller hand-rolled dialect branching that the builder form handles for them.
 */
function warnIfDualDialectLiteral(key: string, expression: unknown): void {
  if (typeof expression !== "string") return;
  const hasMysql = /TIMESTAMPDIFF/i.test(expression);
  const hasPostgres = /EXTRACT\s*\(\s*EPOCH/i.test(expression);
  if (hasMysql && hasPostgres) {
    logger.warn(
      `@ComputedColumn on "${key}": the literal expression ` +
        "mixes MySQL (TIMESTAMPDIFF) and PostgreSQL (EXTRACT(EPOCH …)) " +
        "function names. Use the builder form — expression: (e) => … — so a " +
        "single definition renders dialect-correct DDL on every driver.",
    );
  }
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
    warnIfDualDialectLiteral(key, option.expression);
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
