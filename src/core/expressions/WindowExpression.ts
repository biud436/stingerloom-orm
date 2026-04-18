/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "sql-template-tag";
import type { ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import type { AggregateExpression } from "./AggregateExpression";
import { OrderExpression } from "./OrderExpression";
import { ScalarExpression } from "./ScalarExpression";
import { AliasedExpression } from "./AliasedExpression";

/**
 * Fluent builder for an `<aggregate> OVER (…)` expression — partition,
 * ordering, and frame clause composed incrementally.
 *
 * Returned by {@link AggregateExpression.over}. Terminal methods
 * (`toScalar`, `as`) convert it to a {@link ScalarExpression} /
 * {@link AliasedExpression} for use in SELECT.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 *
 * qb.select([
 *   u.score.sum().over()
 *     .partitionBy(u.teamId)
 *     .orderBy(u.createdAt.desc())
 *     .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
 *     .as("running_total"),
 * ]);
 * ```
 */
export class WindowBuilder {
  private partitions: Array<unknown> = [];
  private orderings: OrderExpression[] = [];
  private frame: string | undefined;

  constructor(private readonly aggregate: AggregateExpression) {}

  /**
   * Add one or more PARTITION BY columns. Accepts entity-aware
   * `ColumnExpression`s (from `qAlias(Entity, "u").col`) or raw
   * `"alias.prop"` strings.
   */
  partitionBy(...cols: Array<unknown>): this {
    this.partitions.push(...cols);
    return this;
  }

  /**
   * Add ORDER BY within the window frame. Accepts `OrderExpression`
   * instances (`u.createdAt.desc()`) — use `addOrderBy`-style fluency
   * on the column expression to construct them.
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

  /** @internal Build the final `FUNC(col) OVER (…)` fragment. */
  private render(
    resolveColumn: ColumnResolver,
    dialect?: DialectExpression,
  ): Sql {
    const aggSql = this.aggregate.renderFunction(resolveColumn);

    const clauses: Sql[] = [];
    if (this.partitions.length > 0) {
      const cols = this.partitions.map((p) =>
        renderPartitionArg(p, resolveColumn, dialect),
      );
      clauses.push(sql`PARTITION BY ${join(cols, ", ")}`);
    }
    if (this.orderings.length > 0) {
      const ordSqls = this.orderings.map((o) =>
        renderOrderFragment(o, resolveColumn),
      );
      clauses.push(sql`ORDER BY ${join(ordSqls, ", ")}`);
    }
    if (this.frame !== undefined) {
      clauses.push(sql`${raw(this.frame)}`);
    }

    if (clauses.length === 0) {
      return sql`${aggSql} OVER ()`;
    }
    return sql`${aggSql} OVER (${join(clauses, " ")})`;
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
): Sql {
  // Aggregate-sourced OrderExpression carries already-rendered SQL via
  // its internal bookkeeping; for window ORDER BY we only support the
  // column-reference form (most common) to keep frame semantics
  // predictable. Callers needing aggregate-in-window should open a
  // follow-up.
  return sql`${raw(resolveColumn(order.ref))} ${raw(order.direction)}`;
}
