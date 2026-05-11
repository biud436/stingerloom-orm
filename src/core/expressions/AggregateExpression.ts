/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "sql-template-tag";
import type { ConditionLike, ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import { OrderExpression } from "./OrderExpression";

/**
 * Renderer for an aggregate's *argument* expression. Used when the
 * aggregate wraps something other than a single column reference —
 * e.g. `AVG(EXTRACT(EPOCH FROM (a - b)) / 3600)`. The query builder
 * calls this at build time with the same resolver / dialect that the
 * surrounding SELECT clause uses.
 */
export type AggregateArgRenderer = (
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
) => Sql;

/**
 * Supported aggregate functions. Kept in sync with
 * `Conditions.ALLOWED_AGGREGATES` so validation is centralized.
 */
export type AggregateFunc = "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";

/**
 * A deferred aggregate expression — e.g. `COUNT(u.id)`, `SUM(u.price)`.
 *
 * Plays two roles:
 * 1. **In SELECT** — call `.as("alias")` and pass to `select()`/`addSelect()`.
 *    The query builder renders `FUNC(col) AS alias`.
 * 2. **In HAVING / WHERE** — comparison methods (`.eq`, `.gt`, etc.) return
 *    an {@link AggregateCondition} that implements {@link ConditionLike}.
 *
 * Created through `ColumnExpression.count()`, `.sum()`, `.avg()`, `.min()`, `.max()`,
 * `.countDistinct()`. Also available statically via the `Expressions` helper.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * const total = u.id.count();           // AggregateExpression
 *
 * qb.select(total.as("total"))          // SELECT COUNT(u.id) AS total
 *   .groupBy(["u.departmentId"])
 *   .having(total.gt(10));              // HAVING COUNT(u.id) > 10
 * ```
 */
export class AggregateExpression {
  readonly __isAggregateExpression = true as const;

  constructor(
    /** Deferred column reference (e.g. `"u.id"`). Resolved at build time. */
    readonly ref: string,
    readonly func: AggregateFunc,
    readonly distinct: boolean,
    /** User-provided alias via `.as("name")`. Undefined until set. */
    readonly alias: string | undefined,
    /**
     * Optional renderer for the aggregate's argument. When set, the
     * aggregate wraps the rendered fragment instead of resolving `ref`
     * as a single column — used by `Expressions.avg(scalarExpr)` etc.
     * `ref` is still consulted for {@link getAlias} so callers can
     * supply a stable default key.
     */
    readonly argRenderer?: AggregateArgRenderer,
  ) {}

  /**
   * Assign a result alias — produces `FUNC(col) AS alias` in SELECT.
   * Required for `getRawMany()` callers that expect predictable keys.
   */
  as(alias: string): AggregateExpression {
    return new AggregateExpression(
      this.ref,
      this.func,
      this.distinct,
      alias,
      this.argRenderer,
    );
  }

  /**
   * Deterministic default alias when none was provided. Callers that rely on
   * raw column access (e.g. `getRawMany()`) should call `.as()` explicitly;
   * this fallback exists so `count()` still produces a stable, predictable
   * result key rather than driver-specific placeholder names.
   */
  getAlias(): string {
    if (this.alias) return this.alias;
    // Strip any leading alias prefix (`"u.id"` → `"id"`) for a cleaner default.
    const col = this.ref.includes(".") ? this.ref.split(".").pop()! : this.ref;
    return this.distinct
      ? `agg_${this.func.toLowerCase()}_distinct_${col}`
      : `agg_${this.func.toLowerCase()}_${col}`;
  }

  /** Build the SQL fragment for this aggregate (no AS clause). */
  renderFunction(
    resolveColumn: ColumnResolver,
    dialect?: DialectExpression,
  ): Sql {
    let inner: Sql;
    if (this.argRenderer) {
      inner = this.argRenderer(resolveColumn, dialect);
    } else if (this.ref === "*") {
      // COUNT(*) support: skip resolution when ref is literal "*".
      inner = sql`${raw("*")}`;
    } else {
      inner = sql`${raw(resolveColumn(this.ref))}`;
    }
    if (this.distinct) {
      return sql`${raw(this.func)}(DISTINCT ${inner})`;
    }
    return sql`${raw(this.func)}(${inner})`;
  }

  // ── Comparison methods → AggregateCondition ───────────────

  eq(value: any): AggregateCondition {
    return new AggregateCondition(this, "=", value);
  }
  neq(value: any): AggregateCondition {
    return new AggregateCondition(this, "!=", value);
  }
  gt(value: any): AggregateCondition {
    return new AggregateCondition(this, ">", value);
  }
  gte(value: any): AggregateCondition {
    return new AggregateCondition(this, ">=", value);
  }
  lt(value: any): AggregateCondition {
    return new AggregateCondition(this, "<", value);
  }
  lte(value: any): AggregateCondition {
    return new AggregateCondition(this, "<=", value);
  }
  between(min: any, max: any): AggregateCondition {
    return new AggregateCondition(this, "BETWEEN", [min, max]);
  }

  // ── Ordering helpers — use the aggregate as an ORDER BY target ──

  asc(): OrderExpression {
    return new OrderExpression(
      this.ref,
      "ASC",
      undefined,
      false,
      (resolveColumn, dialect) => this.renderFunction(resolveColumn, dialect),
    );
  }
  desc(): OrderExpression {
    return new OrderExpression(
      this.ref,
      "DESC",
      undefined,
      false,
      (resolveColumn, dialect) => this.renderFunction(resolveColumn, dialect),
    );
  }

  // ── Window function (Tier 3) ──────────────────────────

  /**
   * Start a window-function chain. Returns a {@link WindowBuilder}
   * that accepts PARTITION BY, ORDER BY, and ROWS/RANGE frame clauses
   * before being finalized with `.as(alias)` or `.toScalar()`.
   *
   * @example
   * ```ts
   * qb.select([
   *   u.score.sum().over()
   *     .partitionBy(u.teamId)
   *     .orderBy(u.createdAt.desc())
   *     .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
   *     .as("running_total"),
   * ]);
   * ```
   */
  over(): WindowBuilder {
    return new WindowBuilder(this);
  }
}

// Imported after the class body to keep a one-way value dependency:
// WindowExpression depends on AggregateExpression as a type only, so
// AggregateExpression can freely construct WindowBuilder without
// forming a compile-time cycle.
import { WindowBuilder } from "./WindowExpression";

/**
 * Build an aggregate over an arbitrary scalar/column-style expression.
 *
 * Use when the aggregate's argument is not a single column reference —
 * e.g. `AVG(EXTRACT(EPOCH FROM (a - b)) / 3600)`, `SUM(CASE WHEN …)`.
 * The `arg` may be a {@link ScalarExpression}, a {@link ColumnExpression},
 * or a `"alias.prop"` string.
 *
 * @example
 * ```ts
 * const i = qAlias(Issue, "i");
 * const cycleHours = Expressions.dateDiff(i.completedAt, i.createdAt, "second")
 *   .floatValue()
 *   .div(3600);
 * qb.select([Expressions.aggregate("AVG", cycleHours).as("avgHours")]);
 * ```
 */
export function aggregateOver(
  func: AggregateFunc,
  arg: unknown,
  options: { distinct?: boolean; defaultAlias?: string } = {},
): AggregateExpression {
  const distinct = options.distinct === true;
  const defaultAlias = options.defaultAlias ?? `expr`;
  return new AggregateExpression(
    defaultAlias,
    func,
    distinct,
    undefined,
    (resolveColumn, dialect) =>
      renderAggregateArg(arg, resolveColumn, dialect),
  );
}

/** @internal Render an aggregate argument — scalar / column / "alias.col" string. */
function renderAggregateArg(
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

/**
 * Type guard — true if `value` is an {@link AggregateExpression}.
 */
export function isAggregateExpression(
  value: unknown,
): value is AggregateExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isAggregateExpression?: unknown })
      .__isAggregateExpression === true
  );
}

/**
 * A deferred HAVING/WHERE condition comparing an {@link AggregateExpression}
 * to a scalar (or BETWEEN range).
 *
 * Implements {@link ConditionLike}, so it can be passed anywhere the query
 * builder accepts conditions: `where()`, `andWhere()`, `having()`.
 */
export class AggregateCondition implements ConditionLike {
  readonly __isCondition = true as const;
  readonly __isAggregateCondition = true as const;

  constructor(
    readonly aggregate: AggregateExpression,
    readonly operator: string,
    readonly value: any,
  ) {}

  resolve(resolveColumn: ColumnResolver): Sql {
    const fn = this.aggregate.renderFunction(resolveColumn);
    const op = this.operator;

    if (op === "BETWEEN") {
      const [min, max] = this.value as [any, any];
      return sql`${fn} BETWEEN ${min} AND ${max}`;
    }

    if (Array.isArray(this.value) && (op === "IN" || op === "NOT IN")) {
      const values = this.value as any[];
      const placeholders = values.map((v) => sql`${v}`);
      return sql`${fn} ${raw(op)} (${join(placeholders, ", ")})`;
    }

    return sql`${fn} ${raw(op)} ${this.value}`;
  }

  /** Compose with another condition using AND (LogicalCondition). */
  and(other: ConditionLike): ConditionLike {
    return LogicalComposer.and(this, other);
  }
  /** Compose with another condition using OR (LogicalCondition). */
  or(other: ConditionLike): ConditionLike {
    return LogicalComposer.or(this, other);
  }
  /** Negate this aggregate condition. */
  not(): ConditionLike {
    return LogicalComposer.not(this);
  }
}

/**
 * Type guard — true if `value` is an {@link AggregateCondition}.
 */
export function isAggregateCondition(
  value: unknown,
): value is AggregateCondition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isAggregateCondition?: unknown })
      .__isAggregateCondition === true
  );
}

/**
 * @internal Tiny indirection layer so this file does not form an import
 * cycle with `LogicalCondition.ts`. The real implementation registers
 * itself at module load time via {@link registerLogicalComposer}.
 */
type LogicalComposerFns = {
  and(a: ConditionLike, b: ConditionLike): ConditionLike;
  or(a: ConditionLike, b: ConditionLike): ConditionLike;
  not(a: ConditionLike): ConditionLike;
};

let LogicalComposer: LogicalComposerFns = {
  and: () => {
    throw new Error(
      "LogicalCondition not registered. Ensure '@stingerloom/orm' is imported via its public entrypoint.",
    );
  },
  or: () => {
    throw new Error(
      "LogicalCondition not registered. Ensure '@stingerloom/orm' is imported via its public entrypoint.",
    );
  },
  not: () => {
    throw new Error(
      "LogicalCondition not registered. Ensure '@stingerloom/orm' is imported via its public entrypoint.",
    );
  },
};

/**
 * @internal Wire up the logical-composer functions after LogicalCondition
 * has been loaded. Called once from `LogicalCondition.ts`.
 */
export function registerLogicalComposer(fns: LogicalComposerFns): void {
  LogicalComposer = fns;
}
