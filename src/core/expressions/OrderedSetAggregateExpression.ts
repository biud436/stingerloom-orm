/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "sql-template-tag";
import type { ConditionLike, ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { unsupportedExpression } from "../../errors/UnsupportedExpressionError";
import { AliasedExpression } from "./AliasedExpression";

/**
 * Names of SQL ordered-set aggregate functions this builder can emit.
 *
 * - `percentile_cont(p) WITHIN GROUP (ORDER BY x)` — linear interpolation
 *   between the two surrounding samples. Returns a numeric type.
 * - `percentile_disc(p) WITHIN GROUP (ORDER BY x)` — discrete: returns the
 *   first input value whose cumulative distribution is >= p.
 * - `mode() WITHIN GROUP (ORDER BY x)` — most-frequent value, ties broken
 *   by the ordering.
 */
export type OrderedSetAggregateFunc =
  | "percentile_cont"
  | "percentile_disc"
  | "mode";

/**
 * Argument types accepted as the `ORDER BY` target inside the WITHIN GROUP
 * clause. Mirrors the value types {@link ScalarExpression} arithmetic accepts.
 */
export type OrderedSetOrderByTarget = unknown;

/**
 * A deferred SQL **ordered-set aggregate** — the `WITHIN GROUP (ORDER BY ...)`
 * family of aggregates standardized in SQL:2003.
 *
 * This expression covers the small set of aggregates whose result depends
 * on the *ordering* of the input rows (not just the set of values), most
 * notably `percentile_cont` / `percentile_disc` for distribution
 * statistics and `mode()` for the most-frequent value.
 *
 * **Dialect support**
 *
 * | Dialect    | `percentile_cont` / `percentile_disc` / `mode`            |
 * |------------|-----------------------------------------------------------|
 * | PostgreSQL | Native — rendered as the SQL-standard ordered-set form.   |
 * | MySQL      | Not supported as an ordered-set aggregate. Emulate with   |
 * |            | a CTE + `ROW_NUMBER() OVER (ORDER BY x)` and `CEIL(N*p)`. |
 * | SQLite     | Not supported. No native ordered-set aggregates.          |
 *
 * On MySQL/SQLite the rendering path throws an explicit
 * {@link OrmError} with `OrmErrorCode.UNSUPPORTED_OPERATION`, so callers
 * fail fast rather than emitting invalid SQL.
 *
 * @example
 * ```ts
 * const i = qAlias(Issue, "i");
 * const cycle = Expressions.dateDiff(i.completedAt, i.createdAt, "second")
 *   .div(3600);
 *
 * qb.select([
 *   Expressions.percentileCont(0.5, cycle).as("p50"),
 *   Expressions.percentileCont(0.95, cycle).as("p95"),
 * ]);
 * ```
 */
export class OrderedSetAggregateExpression {
  readonly __isOrderedSetAggregateExpression = true as const;

  constructor(
    readonly funcName: OrderedSetAggregateFunc,
    /** Fraction in `[0, 1]` for percentile aggregates; `undefined` for `mode()`. */
    readonly fraction: number | undefined,
    /** Expression that produces the ordered series. */
    readonly orderByTarget: OrderedSetOrderByTarget,
    /** Sort direction inside the WITHIN GROUP clause. Defaults to ASC. */
    readonly orderDirection: "ASC" | "DESC",
    /** User-provided alias via `.as("name")`. Undefined until set. */
    readonly alias: string | undefined,
  ) {
    if (funcName === "percentile_cont" || funcName === "percentile_disc") {
      if (fraction === undefined) {
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          `${funcName} requires a fraction in [0, 1].`,
        );
      }
      if (
        typeof fraction !== "number" ||
        Number.isNaN(fraction) ||
        fraction < 0 ||
        fraction > 1
      ) {
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          `${funcName}: fraction must be a number in [0, 1], got ${String(fraction)}.`,
        );
      }
    } else if (funcName === "mode" && fraction !== undefined) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        `mode() ordered-set aggregate takes no fraction argument.`,
      );
    }
  }

  /** Assign a result alias — produces `FUNC(p) WITHIN GROUP (...) AS alias`. */
  as(alias: string): AliasedExpression {
    return new AliasedExpression(alias, (resolveColumn, dialect) =>
      this.render(resolveColumn, dialect),
    );
  }

  /**
   * Alias-free SELECT fragment without `AS clause`. Returned by
   * {@link OrderedSetAggregateExpression.as}'s renderer; exposed for builder
   * internals that want to attach their own alias.
   */
  toScalar(): { renderer: (r: ColumnResolver, d?: DialectExpression) => Sql } {
    return {
      renderer: (resolveColumn, dialect) =>
        this.render(resolveColumn, dialect),
    };
  }

  /** Sort the input rows in ascending order (default). */
  asc(): OrderedSetAggregateExpression {
    return new OrderedSetAggregateExpression(
      this.funcName,
      this.fraction,
      this.orderByTarget,
      "ASC",
      this.alias,
    );
  }

  /** Sort the input rows in descending order. */
  desc(): OrderedSetAggregateExpression {
    return new OrderedSetAggregateExpression(
      this.funcName,
      this.fraction,
      this.orderByTarget,
      "DESC",
      this.alias,
    );
  }

  /**
   * Deterministic default alias when none was provided. Mirrors
   * `AggregateExpression.getAlias()` so callers using `getRawMany()` always
   * see a stable, predictable column key.
   */
  getAlias(): string {
    if (this.alias) return this.alias;
    if (this.funcName === "mode") return "agg_mode";
    const pct = Math.round((this.fraction as number) * 100);
    return `agg_${this.funcName}_${pct}`;
  }

  /** @internal Render the `FUNC(...) WITHIN GROUP (ORDER BY expr)` fragment. */
  render(resolveColumn: ColumnResolver, dialect?: DialectExpression): Sql {
    if (!dialect) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "Ordered-set aggregates require a DialectExpression. Ensure the query " +
          "builder was created via EntityManager.createQueryBuilder().",
      );
    }
    if (dialect.dialect !== "postgres") {
      const isMySql = dialect.dialect === "mysql";
      throw unsupportedExpression({
        feature: `${this.funcName}() WITHIN GROUP (ordered-set aggregate)`,
        dialect: dialect.dialect,
        why:
          dialect.dialect === "sqlite"
            ? "SQLite has no ordered-set aggregates; only PostgreSQL implements the SQL-standard WITHIN GROUP form."
            : "MySQL does not implement the SQL-standard ordered-set aggregate (WITHIN GROUP); only PostgreSQL exposes percentile_cont / percentile_disc / mode natively.",
        alternative: isMySql
          ? "Emulate on MySQL with a CTE: ROW_NUMBER() OVER (ORDER BY x) attaches a rank to each value, then pick the row at rn = CEIL(N * fraction) in the outer query. See docs/cookbook.md#cycle-time-percentile-report for a worked example. Or run this query on PostgreSQL."
          : "Run the query on PostgreSQL, or use raw SQL via em.query() and compute the percentile in application code.",
        approximate: isMySql
          ? "Histogram bucketing on the same column gives a coarser percentile without WINDOW support."
          : undefined,
        docs: "docs/cookbook.md#cycle-time-percentile-report",
      });
    }

    const orderSql = renderOrderTarget(
      this.orderByTarget,
      resolveColumn,
      dialect,
    );
    const dirSuffix = this.orderDirection === "DESC" ? raw(" DESC") : raw("");

    if (this.funcName === "mode") {
      return sql`mode() WITHIN GROUP (ORDER BY ${orderSql}${dirSuffix})`;
    }
    return sql`${raw(this.funcName)}(${this.fraction as number}) WITHIN GROUP (ORDER BY ${orderSql}${dirSuffix})`;
  }
}

/** Render the ORDER BY target — column/scalar expressions unwrap, strings resolve, primitives bind. */
function renderOrderTarget(
  target: unknown,
  resolveColumn: ColumnResolver,
  dialect: DialectExpression,
): Sql {
  if (
    target !== null &&
    typeof target === "object" &&
    (target as { __isScalarExpression?: unknown }).__isScalarExpression === true
  ) {
    return (target as {
      renderer: (r: ColumnResolver, d?: DialectExpression) => Sql;
    }).renderer(resolveColumn, dialect);
  }
  if (
    target !== null &&
    typeof target === "object" &&
    (target as { __isColumnExpression?: unknown }).__isColumnExpression === true
  ) {
    return sql`${raw(resolveColumn((target as { toString(): string }).toString()))}`;
  }
  if (typeof target === "string") {
    return sql`${raw(resolveColumn(target))}`;
  }
  return sql`${target as any}`;
}

/**
 * `percentile_cont(p) WITHIN GROUP (ORDER BY orderBy)` — continuous percentile
 * with linear interpolation between adjacent input values.
 *
 * @param p - Fraction in `[0, 1]` (e.g. `0.5` for the median).
 * @param orderBy - Column / scalar expression / string ref to order the
 *                  input values by.
 *
 * @example
 * ```ts
 * Expressions.percentileCont(0.95, i.duration).as("p95")
 * ```
 */
export function percentileCont(
  p: number,
  orderBy: OrderedSetOrderByTarget,
): OrderedSetAggregateExpression {
  return new OrderedSetAggregateExpression(
    "percentile_cont",
    p,
    orderBy,
    "ASC",
    undefined,
  );
}

/**
 * `percentile_disc(p) WITHIN GROUP (ORDER BY orderBy)` — discrete percentile;
 * returns the first input value whose cumulative distribution >= `p`.
 *
 * Use when interpolation between values is meaningless (e.g. percentiles
 * over an enum-like dimension).
 */
export function percentileDisc(
  p: number,
  orderBy: OrderedSetOrderByTarget,
): OrderedSetAggregateExpression {
  return new OrderedSetAggregateExpression(
    "percentile_disc",
    p,
    orderBy,
    "ASC",
    undefined,
  );
}

/**
 * `mode() WITHIN GROUP (ORDER BY orderBy)` — most-frequent value among the
 * non-null inputs; ties are broken by the ordering.
 */
export function mode(
  orderBy: OrderedSetOrderByTarget,
): OrderedSetAggregateExpression {
  return new OrderedSetAggregateExpression(
    "mode",
    undefined,
    orderBy,
    "ASC",
    undefined,
  );
}

/** Type guard — true if `value` is an {@link OrderedSetAggregateExpression}. */
export function isOrderedSetAggregateExpression(
  value: unknown,
): value is OrderedSetAggregateExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isOrderedSetAggregateExpression?: unknown })
      .__isOrderedSetAggregateExpression === true
  );
}

// ConditionLike marker import so TypeScript does not flag the type-only
// reference above. Ordered-set aggregates cannot appear in WHERE/HAVING
// directly (they require GROUP BY context in any case), so no condition
// comparison methods are exposed.
export type _OrderedSetAggregateLike = ConditionLike;
