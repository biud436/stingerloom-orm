/**
 * Direction of an ORDER BY clause.
 */
export type OrderDirection = "ASC" | "DESC";

/**
 * Position of NULL rows in an ORDER BY clause.
 *
 * - `FIRST` — NULLs sort before non-NULL values (SQL standard for DESC on PG).
 * - `LAST`  — NULLs sort after non-NULL values (SQL standard for ASC on PG).
 *
 * Dialect notes:
 * - PostgreSQL, SQLite ≥ 3.30 — native `NULLS FIRST` / `NULLS LAST`.
 * - MySQL — no native syntax; SelectQueryBuilder emulates via
 *   `ORDER BY (column IS NULL) ASC/DESC, column <dir>`.
 */
export type NullsPosition = "FIRST" | "LAST";

import type { Sql } from "sql-template-tag";
import type { ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";

/**
 * Deferred SQL renderer for an OrderExpression's column slot — used by
 * aggregate / scalar order targets that need full dialect + resolver
 * context to render their function call.
 */
export type OrderExpressionRenderer = (
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
) => Sql;

/**
 * A deferred ORDER BY specification carrying a column reference, direction,
 * and optional NULLS position.
 *
 * Produced by `ColumnExpression.asc()/.desc()`, `AggregateExpression.asc()/.desc()`,
 * and `ScalarExpression.asc()/.desc()`. The query builder resolves the
 * reference through its alias registry at build time.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * qb.orderBy(u.createdAt.desc().nullsLast());
 * qb.addOrderBy(u.name.asc());
 * ```
 */
export class OrderExpression {
  readonly __isOrderExpression = true as const;

  constructor(
    /** The deferred column reference (e.g. `"u.createdAt"`) or pre-rendered SQL fragment. */
    readonly ref: string,
    readonly direction: OrderDirection,
    readonly nulls?: NullsPosition,
    /**
     * When true, `ref` is already a fully-qualified SQL fragment
     * (e.g. `COUNT("u"."id")`) and must NOT be passed through the
     * query builder's column resolver.
     */
    readonly isRaw: boolean = false,
    /**
     * Optional dialect-aware renderer. When present, the SELECT/window
     * builder calls this to produce the column-slot SQL (used by
     * aggregate / scalar expressions whose rendering needs the live
     * dialect handle). Takes precedence over `ref` / `isRaw`.
     */
    readonly renderer?: OrderExpressionRenderer,
  ) {}

  /** Place NULL rows before non-NULL rows in the sort order. */
  nullsFirst(): OrderExpression {
    return new OrderExpression(
      this.ref,
      this.direction,
      "FIRST",
      this.isRaw,
      this.renderer,
    );
  }

  /** Place NULL rows after non-NULL rows in the sort order. */
  nullsLast(): OrderExpression {
    return new OrderExpression(
      this.ref,
      this.direction,
      "LAST",
      this.isRaw,
      this.renderer,
    );
  }
}

/** Type guard — true if `value` is an {@link OrderExpression}. */
export function isOrderExpression(value: unknown): value is OrderExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isOrderExpression?: unknown }).__isOrderExpression === true
  );
}
