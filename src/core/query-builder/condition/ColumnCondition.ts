/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "../../../utils/sqlTag";
import { Conditions } from "../../Conditions";
import type { ConditionLike } from "../../expressions/ConditionLike";
import { LogicalCondition } from "../../expressions/LogicalCondition";
import type { DialectExpression } from "../../../dialects/DialectExpression";

/**
 * A deferred WHERE condition that carries the column reference (unresolved)
 * and resolves it through the query builder's alias registry at build time.
 *
 * Created by `ColumnExpression` methods like `.eq()`, `.like()`, etc.
 * Passed directly to `where()`, `andWhere()`, `orWhere()`.
 */
export class ColumnCondition implements ConditionLike {
  readonly __isCondition = true as const;
  readonly __columnCondition = true as const;
  constructor(
    readonly ref: string,
    readonly operator: string,
    readonly value: any,
    /**
     * Optional renderer for operators that need dialect context (e.g. the
     * case-insensitive LIKE family). When present, {@link resolve} delegates
     * to it instead of the built-in switch below.
     */
    readonly dialectRenderer?: (
      qualified: string,
      dialect: DialectExpression | undefined,
    ) => Sql,
  ) {}

  /**
   * @internal Duck-type guard for `SelectQueryBuilder`-like subqueries.
   * Kept inline to avoid importing the concrete class (which would create
   * a module cycle with the main builder).
   */
  private isSubqueryLike(value: unknown): value is { toSql(): Sql } {
    return (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { toSql?: unknown }).toSql === "function" &&
      typeof (value as { getSql?: unknown }).getSql === "function"
    );
  }

  /**
   * @internal Unwrap a value that may be a {@link ScalarExpression} (e.g.
   * `Expressions.currentTimestamp()`) or a subquery-like `SelectQueryBuilder`
   * into a rendered `Sql` fragment. Plain values pass through unchanged
   * so `sql-template-tag` binds them as parameters.
   */
  private resolveValue(
    value: unknown,
    resolveColumn: (ref: string) => string,
    dialect: DialectExpression | undefined,
  ): unknown {
    if (
      value !== null &&
      typeof value === "object" &&
      (value as { __isScalarExpression?: unknown }).__isScalarExpression === true
    ) {
      return (value as {
        renderer: (
          r: (ref: string) => string,
          d?: DialectExpression,
        ) => Sql;
      }).renderer(resolveColumn, dialect);
    }
    if (
      value !== null &&
      typeof value === "object" &&
      (value as { __isColumnExpression?: unknown }).__isColumnExpression === true
    ) {
      // Another DSL column (e.g. `o.price.gt(o.cost)`) — splice its
      // qualified identifier so it is compared as a column reference,
      // not bound as a parameter object.
      return raw(resolveColumn((value as { toString(): string }).toString()));
    }
    if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { toSql?: unknown }).toSql === "function" &&
      typeof (value as { getSql?: unknown }).getSql === "function"
    ) {
      // SelectQueryBuilder-like — embed as a parenthesized subquery so
      // `col = (SELECT ...)` / `col IN (SELECT ...)` etc. work through
      // the same code path as scalar / primitive comparisons.
      const inner = (value as { toSql(): Sql }).toSql();
      return sql`(${inner})`;
    }
    return value;
  }

  /** @internal Resolve the column reference and produce final SQL. */
  resolve(
    resolveColumn: (ref: string) => string,
    dialect?: DialectExpression,
  ): Sql {
    const qualified = resolveColumn(this.ref);
    if (this.dialectRenderer) {
      return this.dialectRenderer(qualified, dialect);
    }
    const value = this.resolveValue(this.value, resolveColumn, dialect);
    switch (this.operator) {
      case "=":
        if (value === null) return Conditions.isNull(qualified);
        if (Array.isArray(value)) return Conditions.in(qualified, value);
        return Conditions.equals(qualified, value);
      case "!=":
      case "<>":
        if (value === null) return Conditions.isNotNull(qualified);
        if (Array.isArray(value)) return Conditions.notIn(qualified, value);
        return Conditions.notEquals(qualified, value);
      case ">":
        return Conditions.gt(qualified, value);
      case ">=":
        return Conditions.gte(qualified, value);
      case "<":
        return Conditions.lt(qualified, value);
      case "<=":
        return Conditions.lte(qualified, value);
      case "LIKE":
        return Conditions.like(qualified, value as string);
      case "NOT LIKE":
        return Conditions.notLike(qualified, value as string);
      case "IN":
        if (this.value !== null && this.isSubqueryLike(this.value)) {
          const sub = (this.value as { toSql(): Sql }).toSql();
          return sql`${raw(qualified)} IN (${sub})`;
        }
        return Conditions.in(
          qualified,
          (this.value as unknown[]).map((v) =>
            this.resolveValue(v, resolveColumn, dialect),
          ),
        );
      case "NOT IN":
        if (this.value !== null && this.isSubqueryLike(this.value)) {
          const sub = (this.value as { toSql(): Sql }).toSql();
          return sql`${raw(qualified)} NOT IN (${sub})`;
        }
        return Conditions.notIn(
          qualified,
          (this.value as unknown[]).map((v) =>
            this.resolveValue(v, resolveColumn, dialect),
          ),
        );
      case "IS NULL":
        return Conditions.isNull(qualified);
      case "IS NOT NULL":
        return Conditions.isNotNull(qualified);
      case "BETWEEN": {
        const [min, max] = value as [unknown, unknown];
        const minR = this.resolveValue(min, resolveColumn, dialect);
        const maxR = this.resolveValue(max, resolveColumn, dialect);
        return Conditions.between(qualified, minR, maxR);
      }
      default:
        return sql`${raw(qualified)} ${raw(this.operator)} ${value as any}`;
    }
  }

  /** Compose with another condition using AND. */
  and(other: ConditionLike): LogicalCondition {
    return new LogicalCondition("AND", [this, other]);
  }
  /** Compose with another condition using OR. */
  or(other: ConditionLike): LogicalCondition {
    return new LogicalCondition("OR", [this, other]);
  }
  /** Negate this condition. */
  not(): LogicalCondition {
    return new LogicalCondition("NOT", [this]);
  }
}
