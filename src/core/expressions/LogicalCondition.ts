/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, join } from "sql-template-tag";
import type { ConditionLike, ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import { registerLogicalComposer } from "./AggregateExpression";

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
 * Mirrors Java QueryDSL's `Expressions.*` namespace in spirit.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * qb.where(Expressions.and(u.age.gte(18), u.status.eq("active")));
 * qb.where(Expressions.or(u.role.eq("admin"), u.role.eq("owner")));
 * qb.where(Expressions.not(u.deletedAt.isNull()));
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
} as const;

// Register the composer so AggregateCondition.and/.or/.not (and any other
// condition type that wants to delegate) can resolve the LogicalCondition
// factory without forming an import cycle.
registerLogicalComposer({
  and: (a, b) => new LogicalCondition("AND", [a, b]),
  or: (a, b) => new LogicalCondition("OR", [a, b]),
  not: (a) => new LogicalCondition("NOT", [a]),
});
