import type { Sql } from "../../utils/sqlTag";
import type {
  DateAddUnit,
  DateTruncUnit,
  DialectExpression,
} from "../../dialects/DialectExpression";
import type { ColumnResolver } from "./ConditionLike";
import { ScalarExpression, dialectRequired } from "./ScalarExpression";
import { renderExpressionArg } from "./expressionArg";

/**
 * @internal Render any argument usable as a date source — column /
 * scalar expressions unwrap to their inner SQL, an `"alias.col"` string
 * (e.g. `"i.completedAt"`) names a column, other values bind as parameters.
 */
function renderDateArg(
  arg: unknown,
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
): Sql {
  const strings = typeof arg === "string" && arg.includes(".") ? "column" : "value";
  return renderExpressionArg(arg, resolveColumn, dialect, strings);
}

/**
 * `dateDiff(a, b, unit)` — returns `(a - b)` in the given unit as an
 * integer scalar expression. Accepts column / scalar / primitive
 * operands on either side.
 *
 * Engine notes:
 * - **MySQL**: uses `TIMESTAMPDIFF(UNIT, b, a)` — calendar-aware for
 *   year/month, exact for smaller units.
 * - **PostgreSQL**: calendar-aware via `age()` for year/month, epoch
 *   seconds for day/hour/minute/second.
 * - **SQLite**: `julianday()` difference scaled per unit; year/month
 *   are approximations (365.25 and 30.4375 days).
 */
export function dateDiff(
  a: unknown,
  b: unknown,
  unit: DateAddUnit,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    if (!dialect) {
      throw dialectRequired("dateDiff()");
    }
    const aSql = renderDateArg(a, resolveColumn, dialect);
    const bSql = renderDateArg(b, resolveColumn, dialect);
    return dialect.dateDiff(aSql, bSql, unit);
  });
}

/**
 * `dateTrunc(value, unit)` — truncate a date/timestamp to the start of
 * the calendar `unit`. Returns a {@link ScalarExpression} whose runtime
 * SQL is rendered by the active dialect:
 *
 * - PostgreSQL: `date_trunc('<unit>', value)` with the unit as a bound
 *   parameter.
 * - MySQL: explicit per-unit equivalents (`DATE(value)`,
 *   `DATE_FORMAT(value, '%Y-%m-01')`, …) — `week` is ISO-Monday-aligned
 *   so the result matches PostgreSQL semantics.
 * - SQLite: `date(value, 'start of …')` / strftime equivalents,
 *   ISO-Monday week.
 *
 * Returns a date/timestamp value (engine-specific) — callers needing a
 * stable text form should chain `.stringValue()` or format explicitly.
 *
 * @example
 * ```ts
 * const i = qAlias(Issue, "i");
 * qb.select([
 *   Expressions.dateTrunc(i.completedAt, "week").as("weekStart"),
 *   i.id.count().as("closedCount"),
 * ]).groupBy(["weekStart"]);
 * ```
 */
export function dateTrunc(
  value: unknown,
  unit: DateTruncUnit,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    if (!dialect) {
      throw dialectRequired("dateTrunc()");
    }
    const inner = renderDateArg(value, resolveColumn, dialect);
    return dialect.dateTrunc(inner, unit);
  });
}

/**
 * `Expressions.random()` — uniform random in `[0, 1)` (SQLite returns
 * a 64-bit signed integer scalar; downstream code that expects `[0,
 * 1)` should normalize). Commonly used for `ORDER BY random()`.
 */
export function random(): ScalarExpression {
  return new ScalarExpression((_resolveColumn, dialect) => {
    if (!dialect) {
      throw dialectRequired("random()");
    }
    return dialect.random();
  });
}
