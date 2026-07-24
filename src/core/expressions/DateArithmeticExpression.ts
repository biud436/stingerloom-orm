import sql, { Sql, raw } from "../../utils/sqlTag";
import type {
  DateAddUnit,
  DateTruncUnit,
  DialectExpression,
} from "../../dialects/DialectExpression";
import type { ColumnResolver } from "./ConditionLike";
import { ScalarExpression } from "./ScalarExpression";
import type { InnerRenderer } from "./StringExpression";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

function dialectRequired(feature: string): OrmError {
  return new OrmError(
    OrmErrorCode.INVALID_QUERY,
    `${feature} requires a DialectExpression. Ensure the query builder was ` +
      "created via EntityManager.createQueryBuilder() — the dialect is propagated " +
      "from the active EntityManager, so a builder constructed in isolation has no " +
      "way to render dialect-specific SQL.",
  );
}

/**
 * @internal Render any argument usable as a date source — column /
 * scalar expressions unwrap to their inner SQL, plain values bind as
 * parameters.
 */
function renderDateArg(
  arg: unknown,
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
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
  if (typeof arg === "string" && arg.includes(".")) {
    // Treat "alias.col" strings as column refs (e.g. "i.completedAt").
    return sql`${raw(resolveColumn(arg))}`;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sql`${arg as any}`;
}

/**
 * Build a date-addition scalar — `value + N units`. Accepts negative
 * `n` for subtraction (e.g. `addDays(-7)`).
 */
export function buildDateAdd(
  inner: InnerRenderer,
  n: number,
  unit: DateAddUnit,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    if (!dialect) {
      throw dialectRequired("Date add expressions");
    }
    const value = inner(resolveColumn, dialect);
    return dialect.dateAdd(value, n, unit);
  });
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
