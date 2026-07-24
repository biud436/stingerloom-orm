/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "../../utils/sqlTag";
import type { ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import type { AggregateExpression } from "./AggregateExpression";
import { OrderExpression } from "./OrderExpression";
import { ScalarExpression } from "./ScalarExpression";
import { AliasedExpression } from "./AliasedExpression";

/**
 * Renderer for the *head* of a window expression — the function call
 * before `OVER (…)`. For an aggregate window like `SUM(x) OVER (…)` the
 * head is `SUM(x)`; for a pure ranking window like `ROW_NUMBER() OVER (…)`
 * the head is `ROW_NUMBER()`. Centralizing this lets {@link WindowBuilder}
 * compose `OVER (…)` once and serve both shapes.
 */
export type WindowHeadRenderer = (
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
) => Sql;

/**
 * Fluent builder for a `<head> OVER (…)` window expression — partition,
 * ordering, and frame composed incrementally.
 *
 * Two construction paths feed this:
 * 1. **Aggregate-as-window**, via `AggregateExpression.over()`. The head
 *    is the aggregate's rendered `FUNC(col)` fragment.
 * 2. **Pure window function**, via factories like `rowNumber()`, `lag(...)`,
 *    `firstValue(...)`. The head is a plain function call (no GROUP BY
 *    implication).
 *
 * Terminal methods (`toScalar`, `as`) finalize the chain into a
 * {@link ScalarExpression} / {@link AliasedExpression} for SELECT.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 *
 * // Aggregate-as-window
 * u.score.sum().over()
 *   .partitionBy(u.teamId)
 *   .orderBy(u.createdAt.desc())
 *   .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
 *   .as("running_total");
 *
 * // Pure window function
 * Expressions.rowNumber().over()
 *   .partitionBy(u.teamId)
 *   .orderBy(u.score.desc())
 *   .as("rank");
 * ```
 */
export class WindowBuilder {
  private partitions: Array<unknown> = [];
  private orderings: OrderExpression[] = [];
  private frame: string | undefined;

  /**
   * Construct directly via {@link AggregateExpression.over} (legacy
   * aggregate-window path) or {@link WindowBuilder.from} (any head
   * renderer). Both flow into the same `<head> OVER (…)` pipeline.
   */
  constructor(
    private readonly headRendererOrAggregate:
      | WindowHeadRenderer
      | AggregateExpression,
  ) {}

  /**
   * Construct a `WindowBuilder` from any head SQL renderer — used by
   * non-aggregate window factories (`rowNumber()`, `lag()`, …).
   */
  static from(head: WindowHeadRenderer): WindowBuilder {
    return new WindowBuilder(head);
  }

  /**
   * Add one or more PARTITION BY columns. Accepts entity-aware
   * `ColumnExpression`s (from `qAlias(Entity, "u").col`), scalar
   * expressions, or raw `"alias.prop"` strings.
   */
  partitionBy(...cols: Array<unknown>): this {
    this.partitions.push(...cols);
    return this;
  }

  /**
   * Add ORDER BY within the window frame. Accepts `OrderExpression`
   * instances (`u.createdAt.desc()`) — use `.asc()` / `.desc()` on the
   * column expression to construct them.
   */
  orderBy(...orders: OrderExpression[]): this {
    this.orderings.push(...orders);
    return this;
  }

  /**
   * Set a `ROWS BETWEEN <start> AND <end>` frame. `start` / `end`
   * accept SQL frame keywords like `"UNBOUNDED PRECEDING"`,
   * `"CURRENT ROW"`, `"5 PRECEDING"`, `"UNBOUNDED FOLLOWING"`.
   *
   * Callers are responsible for ensuring the strings are safe SQL
   * fragments — do not pass user input here.
   */
  rowsBetween(start: string, end: string): this {
    this.frame = `ROWS BETWEEN ${start} AND ${end}`;
    return this;
  }

  /** Same as {@link rowsBetween} but emits `RANGE BETWEEN …`. */
  rangeBetween(start: string, end: string): this {
    this.frame = `RANGE BETWEEN ${start} AND ${end}`;
    return this;
  }

  /** Finalize as a {@link ScalarExpression} for nesting. */
  toScalar(): ScalarExpression {
    return new ScalarExpression((resolveColumn, dialect) =>
      this.render(resolveColumn, dialect),
    );
  }

  /** Shorthand — finalize with a SELECT alias. */
  as(alias: string): AliasedExpression {
    return this.toScalar().as(alias);
  }

  /** @internal Build the final `<head> OVER (…)` fragment. */
  private render(
    resolveColumn: ColumnResolver,
    dialect?: DialectExpression,
  ): Sql {
    const headSql = this.renderHead(resolveColumn, dialect);

    const clauses: Sql[] = [];
    if (this.partitions.length > 0) {
      const cols = this.partitions.map((p) =>
        renderPartitionArg(p, resolveColumn, dialect),
      );
      clauses.push(sql`PARTITION BY ${join(cols, ", ")}`);
    }
    if (this.orderings.length > 0) {
      const ordSqls = this.orderings.map((o) =>
        renderOrderFragment(o, resolveColumn, dialect),
      );
      clauses.push(sql`ORDER BY ${join(ordSqls, ", ")}`);
    }
    if (this.frame !== undefined) {
      clauses.push(sql`${raw(this.frame)}`);
    }

    if (clauses.length === 0) {
      return sql`${headSql} OVER ()`;
    }
    return sql`${headSql} OVER (${join(clauses, " ")})`;
  }

  /** @internal Render the function-call portion before `OVER (…)`. */
  private renderHead(
    resolveColumn: ColumnResolver,
    dialect?: DialectExpression,
  ): Sql {
    const head = this.headRendererOrAggregate;
    if (typeof head === "function") {
      return head(resolveColumn, dialect);
    }
    return (head as AggregateExpression).renderFunction(resolveColumn, dialect);
  }
}

/** @internal Render a partition argument as qualified column SQL. */
function renderPartitionArg(
  arg: unknown,
  resolveColumn: ColumnResolver,
  dialect: DialectExpression | undefined,
): Sql {
  if (
    arg !== null &&
    typeof arg === "object" &&
    (arg as { __isColumnExpression?: unknown }).__isColumnExpression === true
  ) {
    return sql`${raw(
      resolveColumn((arg as { toString(): string }).toString()),
    )}`;
  }
  if (
    arg !== null &&
    typeof arg === "object" &&
    (arg as { __isScalarExpression?: unknown }).__isScalarExpression === true
  ) {
    return (arg as {
      renderer: (r: ColumnResolver, d?: DialectExpression) => Sql;
    }).renderer(resolveColumn, dialect);
  }
  if (typeof arg === "string") {
    return sql`${raw(resolveColumn(arg))}`;
  }
  throw new Error(
    `WindowBuilder.partitionBy: unsupported argument of type ${typeof arg}`,
  );
}

/** @internal Render an OrderExpression as `col DIR` SQL inside OVER (). */
function renderOrderFragment(
  order: OrderExpression,
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
): Sql {
  if (order.renderer) {
    // Aggregate / scalar-sourced order — defer to the expression's own
    // renderer so the function call (or derived SQL) appears verbatim.
    const colSql = order.renderer(resolveColumn, dialect);
    return sql`${colSql} ${raw(order.direction)}`;
  }
  if (order.isRaw) {
    return sql`${raw(order.ref)} ${raw(order.direction)}`;
  }
  return sql`${raw(resolveColumn(order.ref))} ${raw(order.direction)}`;
}
