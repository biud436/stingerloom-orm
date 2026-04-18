import type { Sql } from "sql-template-tag";
import type { ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";

/**
 * Produces the inner SQL fragment for a SELECT-position expression
 * (without the trailing `AS alias` clause).
 *
 * @internal Implemented by {@link ColumnExpression.as} and
 * {@link JsonPathExpression.as}; the query builder supplies the column
 * resolver and (when available) the target dialect at build time.
 */
export type AliasedRenderer = (
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
) => Sql;

/**
 * A SELECT-position expression tagged with a result alias.
 *
 * Produced by calling `.as("name")` on a column- or JSON-path
 * expression. Pass it to `select()` / `addSelect()` to render as
 * `<expression> AS <alias>`.
 *
 * ⚠ Only meaningful in SELECT — an `AliasedExpression` is not a
 * {@link ConditionLike} and cannot be passed to `where()` / `having()`.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 *
 * // Column aliasing
 * qb.select([u.firstName.as("name"), u.age.as("years")]);
 *
 * // JSON path aliasing (dialect-specific extract)
 * qb.select([u.metadata.profile.email.as("contact_email")]);
 * ```
 */
export class AliasedExpression {
  readonly __isAliasedExpression = true as const;

  constructor(
    /** User-provided alias from `.as("name")`. */
    readonly alias: string,
    /** Renderer that produces the inner SQL fragment (no AS clause). */
    readonly renderer: AliasedRenderer,
  ) {}
}

/**
 * Type guard — true if `value` is an {@link AliasedExpression}.
 */
export function isAliasedExpression(
  value: unknown,
): value is AliasedExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isAliasedExpression?: unknown }).__isAliasedExpression ===
      true
  );
}
