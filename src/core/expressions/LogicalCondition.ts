/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, join } from "sql-template-tag";
import type { ConditionLike, ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import {
  AggregateExpression,
  registerLogicalComposer,
  aggregateOver,
  type AggregateFunc,
} from "./AggregateExpression";
import { registerScalarLogicalComposer } from "./ScalarExpression";
import { coalesce, nullif } from "./NullishExpression";
import {
  currentDate,
  currentTime,
  currentTimestamp,
} from "./TemporalExpression";
import type { ScalarExpression } from "./ScalarExpression";
import {
  exists as existsFactory,
  notExists as notExistsFactory,
  registerExistsLogicalComposer,
  ExistsCondition,
} from "./SubqueryExpression";
import {
  caseBuilder as caseBuilderFactory,
  cases as casesFactory,
  iff as iffFactory,
  mapValues as mapValuesFactory,
  buckets as bucketsFactory,
  CaseBuilder,
  CaseValueBuilder,
  type BucketOperator,
} from "./CaseExpression";
import {
  dateDiff as dateDiffFactory,
  dateTrunc as dateTruncFactory,
  random as randomFactory,
} from "./DateArithmeticExpression";
import { rawExpr as rawFactory } from "./RawExpression";
import {
  tuple as tupleFactory,
  TupleExpression,
  type TupleColumn,
} from "./TupleExpression";
import {
  percentileCont as percentileContFactory,
  percentileDisc as percentileDiscFactory,
  mode as modeFactory,
  OrderedSetAggregateExpression,
  type OrderedSetOrderByTarget,
} from "./OrderedSetAggregateExpression";
import {
  rowNumber as rowNumberFactory,
  rank as rankFactory,
  denseRank as denseRankFactory,
  ntile as ntileFactory,
  percentRank as percentRankFactory,
  cumeDist as cumeDistFactory,
  lag as lagFactory,
  lead as leadFactory,
  firstValue as firstValueFactory,
  lastValue as lastValueFactory,
  nthValue as nthValueFactory,
} from "./WindowFunctions";
import type { WindowBuilder } from "./WindowExpression";
import type {
  DateAddUnit,
  DateTruncUnit,
} from "../../dialects/DialectExpression";

export type LogicalOperator = "AND" | "OR" | "NOT";

/**
 * A composite condition — AND, OR, or NOT — built from other
 * {@link ConditionLike} instances.
 *
 * Users rarely instantiate this directly; instead they chain `.and()`,
 * `.or()`, `.not()` on existing conditions, or call the static helpers
 * `Expressions.and(...)`, `.or(...)`, `.not(...)`.
 *
 * Associativity: `a.and(b).or(c)` reads as `(a AND b) OR c` — the method
 * chain groups left to right. For different grouping, use the static
 * helpers: `Expressions.or(a, Expressions.and(b, c))`.
 */
export class LogicalCondition implements ConditionLike {
  readonly __isCondition = true as const;
  readonly __isLogicalCondition = true as const;

  constructor(
    readonly op: LogicalOperator,
    readonly children: ReadonlyArray<ConditionLike>,
  ) {
    if (op === "NOT" && children.length !== 1) {
      throw new Error(
        `LogicalCondition 'NOT' expects exactly 1 child, got ${children.length}`,
      );
    }
    if (op !== "NOT" && children.length < 1) {
      throw new Error(
        `LogicalCondition '${op}' expects at least 1 child, got 0`,
      );
    }
  }

  resolve(resolveColumn: ColumnResolver, dialect?: DialectExpression): Sql {
    if (this.op === "NOT") {
      const inner = this.children[0].resolve(resolveColumn, dialect);
      return sql`NOT (${inner})`;
    }

    // Single-child AND/OR collapses to just the child (avoids "(x)" noise).
    if (this.children.length === 1) {
      return this.children[0].resolve(resolveColumn, dialect);
    }

    const parts = this.children.map((c) => c.resolve(resolveColumn, dialect));
    const separator = this.op === "AND" ? " AND " : " OR ";
    return sql`(${join(parts, separator)})`;
  }

  /** Compose with another condition using AND. */
  and(other: ConditionLike): LogicalCondition {
    // Flatten AND-of-AND for cleaner SQL. NOT stays opaque.
    if (this.op === "AND") {
      return new LogicalCondition("AND", [...this.children, other]);
    }
    return new LogicalCondition("AND", [this, other]);
  }

  /** Compose with another condition using OR. */
  or(other: ConditionLike): LogicalCondition {
    if (this.op === "OR") {
      return new LogicalCondition("OR", [...this.children, other]);
    }
    return new LogicalCondition("OR", [this, other]);
  }

  /** Negate this composite condition. */
  not(): LogicalCondition {
    return new LogicalCondition("NOT", [this]);
  }
}

/** Type guard — true if `value` is a {@link LogicalCondition}. */
export function isLogicalCondition(value: unknown): value is LogicalCondition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isLogicalCondition?: unknown }).__isLogicalCondition === true
  );
}

/**
 * Static helpers for building logical compositions and referencing
 * current-date/time expressions.
 *
 * Mirrors Java QueryDSL's `Expressions.*` namespace in spirit. The name
 * is a mouthful at call sites, so examples and docs tend to import it
 * under a short alias — `import { Expressions as exp }` — and call
 * `exp.and(...)`, `exp.iff(...)`, etc.
 *
 * @example
 * ```ts
 * import { Expressions as exp, qAlias } from "@stingerloom/orm";
 *
 * const u = qAlias(User, "u");
 * qb.where(exp.and(u.age.gte(18), u.status.eq("active")));
 * qb.where(exp.or(u.role.eq("admin"), u.role.eq("owner")));
 * qb.where(exp.not(u.deletedAt.isNull()));
 * ```
 */
export const Expressions = {
  /**
   * Combine 2+ conditions with AND. Returns a {@link LogicalCondition}.
   */
  and(first: ConditionLike, ...rest: ConditionLike[]): LogicalCondition {
    return new LogicalCondition("AND", [first, ...rest]);
  },

  /**
   * Combine 2+ conditions with OR. Returns a {@link LogicalCondition}.
   */
  or(first: ConditionLike, ...rest: ConditionLike[]): LogicalCondition {
    return new LogicalCondition("OR", [first, ...rest]);
  },

  /**
   * Wrap a condition in NOT. Returns a {@link LogicalCondition}.
   */
  not(cond: ConditionLike): LogicalCondition {
    return new LogicalCondition("NOT", [cond]);
  },

  /**
   * Row-value (tuple) constructor — `(c1, c2, …)` — for comparing several
   * columns at once. The natural fit for composite-PK lookups.
   *
   * @example
   * ```ts
   * Expressions.tuple(u.tenantId, u.userId).in([[1, "alice"], [2, "bob"]])
   * // (tenant_id, user_id) IN ((?, ?), (?, ?))
   * ```
   */
  tuple(...columns: TupleColumn[]): TupleExpression {
    return tupleFactory(...columns);
  },

  /**
   * `COALESCE(a, b, c, …)` — first non-null argument.
   *
   * Accepts any mix of {@link ColumnExpression}, {@link ScalarExpression},
   * {@link AggregateExpression}, JSON path extractions, and plain
   * values. Requires at least 2 arguments.
   *
   * @example
   * ```ts
   * Expressions.coalesce(u.nickname, u.name, "anonymous")
   * ```
   */
  coalesce(first: unknown, second: unknown, ...rest: unknown[]): ScalarExpression {
    return coalesce(first, second, ...rest);
  },

  /**
   * `NULLIF(a, b)` — returns `NULL` when `a === b`, otherwise `a`.
   *
   * @example
   * ```ts
   * Expressions.nullif(u.email, "")  // turn empty string into NULL
   * ```
   */
  nullif(a: unknown, b: unknown): ScalarExpression {
    return nullif(a, b);
  },

  /** `CURRENT_DATE` — the database server's current date. */
  currentDate(): ScalarExpression {
    return currentDate();
  },

  /** `CURRENT_TIME` — the database server's current time of day. */
  currentTime(): ScalarExpression {
    return currentTime();
  },

  /** `CURRENT_TIMESTAMP` — the database server's current date+time. */
  currentTimestamp(): ScalarExpression {
    return currentTimestamp();
  },

  /**
   * `EXISTS (subquery)`. Pass a `SelectQueryBuilder`; the subquery is
   * rendered (with bindings preserved) at condition-resolution time.
   */
  exists(subquery: { toSql(): import("sql-template-tag").Sql }): ExistsCondition {
    return existsFactory(subquery);
  },

  /** `NOT EXISTS (subquery)`. Mirror of {@link exists}. */
  notExists(
    subquery: { toSql(): import("sql-template-tag").Sql },
  ): ExistsCondition {
    return notExistsFactory(subquery);
  },

  /**
   * Start a **searched** `CASE WHEN cond THEN val … ELSE val END`
   * builder. Chain `.when(cond).then(val)` for each branch, optionally
   * finish with `.otherwise(val)`, then call `.end()` to finalize.
   */
  caseBuilder(): CaseBuilder {
    return caseBuilderFactory();
  },

  /**
   * Start a **simple** `CASE value WHEN v1 THEN r1 …` builder. Useful
   * for value-switching — e.g. converting a status column into a
   * priority number.
   */
  cases(subject: unknown): CaseValueBuilder {
    return casesFactory(subject);
  },

  /**
   * Shortcut for two-branch `CASE WHEN cond THEN a ELSE b END` — the SQL
   * equivalent of a ternary. Prefer this over {@link caseBuilder} when
   * exactly one condition picks between two results (soft delete flags,
   * feature gates, Y/N formatting).
   *
   * @example
   * ```ts
   * Expressions.iff(u.deletedAt.isNull(), "active", "deleted")
   * ```
   */
  iff(
    condition: ConditionLike,
    whenTrue: unknown,
    whenFalse: unknown,
  ): ScalarExpression {
    return iffFactory(condition, whenTrue, whenFalse);
  },

  /**
   * Shortcut for simple `CASE subject WHEN v1 THEN r1 … ELSE d END`
   * built from an object literal. Prefer this over {@link cases} when
   * the mapping is a static one-to-one relationship from known values
   * to constants.
   *
   * @example
   * ```ts
   * Expressions.mapValues(u.status, { active: 1, pending: 0 }, -1)
   * ```
   */
  mapValues(
    subject: unknown,
    mapping: Record<string, unknown>,
    defaultResult?: unknown,
  ): ScalarExpression {
    return mapValuesFactory(subject, mapping, defaultResult);
  },

  /**
   * Shortcut for threshold ladders — a searched `CASE` where every
   * branch compares the same subject to a different threshold with the
   * same operator (score → tier, latency → bucket, age → cohort).
   * Branches are emitted in the given order.
   *
   * @example
   * ```ts
   * Expressions.buckets(u.score, [[90, "gold"], [70, "silver"]], "bronze")
   * ```
   */
  buckets(
    subject: Parameters<typeof bucketsFactory>[0],
    thresholds: ReadonlyArray<readonly [unknown, unknown]>,
    defaultResult?: unknown,
    options?: { op?: BucketOperator },
  ): ScalarExpression {
    return bucketsFactory(subject, thresholds, defaultResult, options);
  },

  /**
   * `dateDiff(a, b, unit)` — integer difference `a - b` in the given
   * unit. Calendar-aware for `year`/`month` on MySQL and PostgreSQL;
   * SQLite uses `julianday()` approximation for those.
   */
  dateDiff(a: unknown, b: unknown, unit: DateAddUnit): ScalarExpression {
    return dateDiffFactory(a, b, unit);
  },

  /**
   * `dateTrunc(value, unit)` — truncate a date/timestamp to the start of
   * the given calendar `unit`. `week` follows the ISO-Monday convention
   * on every dialect so cross-engine callers see the same week-start
   * date.
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
  dateTrunc(value: unknown, unit: DateTruncUnit): ScalarExpression {
    return dateTruncFactory(value, unit);
  },

  /**
   * `AVG(arg)` over an arbitrary expression — column, scalar expression,
   * or `"alias.prop"` string. Mirror of {@link ColumnExpression.avg} for
   * cases where the aggregate's argument is a derived expression rather
   * than a single column reference (e.g. `AVG(EXTRACT(epoch FROM (a-b))/3600)`).
   *
   * @example
   * ```ts
   * const cycleHours = Expressions.dateDiff(i.completedAt, i.createdAt, "second")
   *   .floatValue().div(3600);
   * qb.select([Expressions.avg(cycleHours).as("avgHours")]);
   * ```
   */
  avg(arg: unknown): AggregateExpression {
    return aggregateOver("AVG", arg, { defaultAlias: "avg_expr" });
  },

  /** `SUM(arg)` over an arbitrary expression. See {@link avg}. */
  sum(arg: unknown): AggregateExpression {
    return aggregateOver("SUM", arg, { defaultAlias: "sum_expr" });
  },

  /** `MIN(arg)` over an arbitrary expression. See {@link avg}. */
  min(arg: unknown): AggregateExpression {
    return aggregateOver("MIN", arg, { defaultAlias: "min_expr" });
  },

  /** `MAX(arg)` over an arbitrary expression. See {@link avg}. */
  max(arg: unknown): AggregateExpression {
    return aggregateOver("MAX", arg, { defaultAlias: "max_expr" });
  },

  /** `COUNT(arg)` over an arbitrary expression — pass `"*"` for `COUNT(*)`. */
  count(arg: unknown = "*"): AggregateExpression {
    return aggregateOver("COUNT", arg, { defaultAlias: "count_expr" });
  },

  /**
   * Build an arbitrary `<FUNC>(arg)` aggregate using an arbitrary expression.
   * Escape hatch when you need DISTINCT alongside a derived argument:
   *
   * ```ts
   * Expressions.aggregate("COUNT", u.email, { distinct: true })
   * ```
   */
  aggregate(
    func: AggregateFunc,
    arg: unknown,
    options?: { distinct?: boolean; defaultAlias?: string },
  ): AggregateExpression {
    return aggregateOver(func, arg, options);
  },

  /**
   * `RANDOM()` / `RAND()` — dialect-native pseudo-random scalar.
   * Commonly used as `qb.orderBy(Expressions.random().asc())` for
   * random sampling, though the order expression wiring lives in a
   * future phase.
   */
  random(): ScalarExpression {
    return randomFactory();
  },

  /**
   * Escape hatch — wrap a raw `Sql` fragment as a
   * {@link ScalarExpression}. The generic `T` is a TypeScript marker
   * that documents the intended return type; it flows through
   * downstream chains but is not enforced at runtime.
   *
   * Callers take responsibility for the safety of the raw SQL.
   *
   * @example
   * ```ts
   * import sql from "sql-template-tag";
   * const epoch = Expressions.raw<number>(
   *   sql`EXTRACT(epoch FROM ${u.col("createdAt")})`,
   * );
   * qb.select([epoch.as("epoch_s")]).where(epoch.gt(1700000000));
   * ```
   */
  raw<T = unknown>(fragment: import("sql-template-tag").Sql): ScalarExpression {
    return rawFactory<T>(fragment);
  },

  /**
   * `percentile_cont(p) WITHIN GROUP (ORDER BY orderBy)` — continuous
   * percentile with linear interpolation between adjacent samples.
   *
   * **PostgreSQL only.** MySQL and SQLite have no native ordered-set
   * aggregate; on those dialects the renderer throws
   * `OrmError(UNSUPPORTED_OPERATION)`. Emulate on MySQL via a CTE +
   * `ROW_NUMBER() OVER (ORDER BY x)` and pick the row where
   * `rn = CEIL(N * fraction)`.
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
  percentileCont(
    p: number,
    orderBy: OrderedSetOrderByTarget,
  ): OrderedSetAggregateExpression {
    return percentileContFactory(p, orderBy);
  },

  /**
   * `percentile_disc(p) WITHIN GROUP (ORDER BY orderBy)` — discrete
   * percentile; returns the first input value whose cumulative
   * distribution is >= `p`.
   *
   * **PostgreSQL only.** See {@link percentileCont} for dialect notes.
   */
  percentileDisc(
    p: number,
    orderBy: OrderedSetOrderByTarget,
  ): OrderedSetAggregateExpression {
    return percentileDiscFactory(p, orderBy);
  },

  /**
   * `mode() WITHIN GROUP (ORDER BY orderBy)` — most-frequent value among
   * the non-null inputs; ties broken by the ordering.
   *
   * **PostgreSQL only.** See {@link percentileCont} for dialect notes.
   */
  mode(
    orderBy: OrderedSetOrderByTarget,
  ): OrderedSetAggregateExpression {
    return modeFactory(orderBy);
  },

  // ── Ranking window functions ───────────────────────────

  /**
   * `ROW_NUMBER() OVER (…)` — sequential row number within each partition,
   * starting at 1. Returns a {@link WindowBuilder} so callers can chain
   * `.partitionBy(...)`, `.orderBy(...)`, `.rowsBetween(...)` before
   * finalizing with `.as(alias)`.
   */
  rowNumber(): WindowBuilder {
    return rowNumberFactory();
  },

  /** `RANK() OVER (…)` — ties share a rank; next rank skips duplicates. */
  rank(): WindowBuilder {
    return rankFactory();
  },

  /** `DENSE_RANK() OVER (…)` — like {@link rank} but no gaps after ties. */
  denseRank(): WindowBuilder {
    return denseRankFactory();
  },

  /** `NTILE(n) OVER (…)` — split partition into `n` ordered buckets (1..n). */
  ntile(n: number): WindowBuilder {
    return ntileFactory(n);
  },

  /** `PERCENT_RANK() OVER (…)` — `(rank-1) / (rows-1)`, in `[0, 1]`. */
  percentRank(): WindowBuilder {
    return percentRankFactory();
  },

  /** `CUME_DIST() OVER (…)` — cumulative distribution; `≤ current_value` ratio. */
  cumeDist(): WindowBuilder {
    return cumeDistFactory();
  },

  // ── Positional / offset window functions ──────────────

  /**
   * `LAG(expr [, offset [, default]]) OVER (…)` — value `offset` rows
   * before the current row. `default` is returned when the offset would
   * cross the partition boundary.
   *
   * @example
   * ```ts
   * Expressions.lag(a.createdAt).over()
   *   .partitionBy(a.issueId)
   *   .orderBy(a.createdAt.asc())
   *   .as("prev_change_at");
   * ```
   */
  lag(expr: unknown, offset?: number, defaultValue?: unknown): WindowBuilder {
    return lagFactory(expr, offset, defaultValue);
  },

  /** `LEAD(expr [, offset [, default]]) OVER (…)` — see {@link lag}. */
  lead(expr: unknown, offset?: number, defaultValue?: unknown): WindowBuilder {
    return leadFactory(expr, offset, defaultValue);
  },

  /** `FIRST_VALUE(expr) OVER (…)` — value at the first row of the window frame. */
  firstValue(expr: unknown): WindowBuilder {
    return firstValueFactory(expr);
  },

  /** `LAST_VALUE(expr) OVER (…)` — value at the last row of the window frame. */
  lastValue(expr: unknown): WindowBuilder {
    return lastValueFactory(expr);
  },

  /** `NTH_VALUE(expr, n) OVER (…)` — value at the n-th row (1-indexed). */
  nthValue(expr: unknown, n: number): WindowBuilder {
    return nthValueFactory(expr, n);
  },
} as const;

// Register the composer so AggregateCondition.and/.or/.not (and any other
// condition type that wants to delegate) can resolve the LogicalCondition
// factory without forming an import cycle.
registerLogicalComposer({
  and: (a, b) => new LogicalCondition("AND", [a, b]),
  or: (a, b) => new LogicalCondition("OR", [a, b]),
  not: (a) => new LogicalCondition("NOT", [a]),
});

registerScalarLogicalComposer({
  and: (a, b) => new LogicalCondition("AND", [a, b]),
  or: (a, b) => new LogicalCondition("OR", [a, b]),
  not: (a) => new LogicalCondition("NOT", [a]),
});

registerExistsLogicalComposer({
  and: (a, b) => new LogicalCondition("AND", [a, b]),
  or: (a, b) => new LogicalCondition("OR", [a, b]),
  not: (a) => new LogicalCondition("NOT", [a]),
});
