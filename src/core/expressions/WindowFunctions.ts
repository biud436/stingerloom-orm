/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "../../utils/sqlTag";
import type { ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import { WindowBuilder, type WindowHeadRenderer } from "./WindowExpression";

/**
 * @internal Resolve an arbitrary argument that may appear inside a
 * window function call — column expression, scalar expression,
 * `"alias.col"` string, or a primitive bound as a parameter.
 */
function renderWindowArg(
  arg: unknown,
  resolveColumn: ColumnResolver,
  dialect: DialectExpression | undefined,
): Sql {
  if (
    arg !== null &&
    typeof arg === "object" &&
    (arg as { __isScalarExpression?: unknown }).__isScalarExpression === true
  ) {
    return (arg as {
      renderer: (r: ColumnResolver, d?: DialectExpression) => Sql;
    }).renderer(resolveColumn, dialect);
  }
  if (
    arg !== null &&
    typeof arg === "object" &&
    (arg as { __isColumnExpression?: unknown }).__isColumnExpression === true
  ) {
    return sql`${raw(resolveColumn((arg as { toString(): string }).toString()))}`;
  }
  if (typeof arg === "string") {
    return sql`${raw(resolveColumn(arg))}`;
  }
  return sql`${arg as any}`;
}

/** @internal Build a `FUNC()` head renderer with no arguments. */
function noArgHead(name: string): WindowHeadRenderer {
  return () => sql`${raw(name)}()`;
}

/** @internal Build a `FUNC(arg)` head renderer for a single argument. */
function oneArgHead(name: string, arg: unknown): WindowHeadRenderer {
  return (resolveColumn, dialect) => {
    const argSql = renderWindowArg(arg, resolveColumn, dialect);
    return sql`${raw(name)}(${argSql})`;
  };
}

/**
 * `ROW_NUMBER()` — sequential row number within the window partition,
 * starting at 1. Ties are broken arbitrarily; use {@link rank} when ties
 * should share a rank.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * Expressions.rowNumber().over()
 *   .partitionBy(u.teamId)
 *   .orderBy(u.score.desc())
 *   .as("rn");
 * ```
 */
export function rowNumber(): WindowBuilder {
  return WindowBuilder.from(noArgHead("ROW_NUMBER"));
}

/**
 * `RANK()` — rank within the partition; tied rows share a rank and the
 * next rank skips the duplicates (1, 2, 2, 4 …).
 */
export function rank(): WindowBuilder {
  return WindowBuilder.from(noArgHead("RANK"));
}

/**
 * `DENSE_RANK()` — like {@link rank} but the next rank does not skip
 * duplicates (1, 2, 2, 3 …).
 */
export function denseRank(): WindowBuilder {
  return WindowBuilder.from(noArgHead("DENSE_RANK"));
}

/**
 * `NTILE(n)` — distribute rows into `n` roughly-equal buckets, returning
 * the bucket number (1..n).
 *
 * @param n - Number of buckets. Must be a positive integer.
 */
export function ntile(n: number): WindowBuilder {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`ntile(n): n must be a positive integer, got ${n}`);
  }
  return WindowBuilder.from(() => sql`NTILE(${n})`);
}

/**
 * `PERCENT_RANK()` — `(rank - 1) / (total_rows - 1)`. Returns 0 for the
 * first row in the partition; 1 for the last; intermediate fractions
 * between.
 */
export function percentRank(): WindowBuilder {
  return WindowBuilder.from(noArgHead("PERCENT_RANK"));
}

/**
 * `CUME_DIST()` — cumulative distribution. Fraction of rows whose value
 * is ≤ the current row's value.
 */
export function cumeDist(): WindowBuilder {
  return WindowBuilder.from(noArgHead("CUME_DIST"));
}

/**
 * `LAG(expr [, offset [, default]])` — value from the row `offset`
 * positions before the current row. `default` is returned when the
 * offset crosses the partition boundary.
 *
 * @param expr   - Column / scalar / `"alias.prop"` to read.
 * @param offset - How many rows back (default 1).
 * @param defaultValue - Optional default when out of range.
 */
export function lag(
  expr: unknown,
  offset = 1,
  defaultValue?: unknown,
): WindowBuilder {
  return WindowBuilder.from(buildLagLeadHead("LAG", expr, offset, defaultValue));
}

/**
 * `LEAD(expr [, offset [, default]])` — value from the row `offset`
 * positions after the current row.
 */
export function lead(
  expr: unknown,
  offset = 1,
  defaultValue?: unknown,
): WindowBuilder {
  return WindowBuilder.from(buildLagLeadHead("LEAD", expr, offset, defaultValue));
}

function buildLagLeadHead(
  name: "LAG" | "LEAD",
  expr: unknown,
  offset: number,
  defaultValue: unknown,
): WindowHeadRenderer {
  return (resolveColumn, dialect) => {
    const argSql = renderWindowArg(expr, resolveColumn, dialect);
    if (defaultValue !== undefined) {
      const def = renderWindowArg(defaultValue, resolveColumn, dialect);
      return sql`${raw(name)}(${argSql}, ${offset}, ${def})`;
    }
    if (offset !== 1) {
      return sql`${raw(name)}(${argSql}, ${offset})`;
    }
    return sql`${raw(name)}(${argSql})`;
  };
}

/**
 * `FIRST_VALUE(expr)` — value of `expr` for the first row in the window
 * frame. Pair with `rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")`
 * for the partition's running first value.
 */
export function firstValue(expr: unknown): WindowBuilder {
  return WindowBuilder.from(oneArgHead("FIRST_VALUE", expr));
}

/** `LAST_VALUE(expr)` — value for the last row in the window frame. */
export function lastValue(expr: unknown): WindowBuilder {
  return WindowBuilder.from(oneArgHead("LAST_VALUE", expr));
}

/**
 * `NTH_VALUE(expr, n)` — value of `expr` at the n-th row in the window
 * frame (1-indexed). Returns NULL when out of range.
 */
export function nthValue(expr: unknown, n: number): WindowBuilder {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`nthValue(expr, n): n must be a positive integer, got ${n}`);
  }
  return WindowBuilder.from((resolveColumn, dialect) => {
    const argSql = renderWindowArg(expr, resolveColumn, dialect);
    return sql`NTH_VALUE(${argSql}, ${n})`;
  });
}
