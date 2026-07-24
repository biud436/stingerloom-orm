/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql } from "../../utils/sqlTag";
import type { ConditionLike, ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";

/**
 * Duck-type guard — true if `value` looks like a `SelectQueryBuilder`
 * (has `.toSql()` + `.getSql()` methods). Kept as duck typing to avoid
 * an import cycle from `src/core/SelectQueryBuilder.ts`.
 */
export function isSubqueryLike(
  value: unknown,
): value is { toSql(): Sql } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toSql?: unknown }).toSql === "function" &&
    typeof (value as { getSql?: unknown }).getSql === "function"
  );
}

/**
 * @internal Render a subquery-like value (e.g. a `SelectQueryBuilder`)
 * as a parenthesized `Sql` fragment suitable for embedding in an IN /
 * EXISTS / scalar-comparison position.
 */
export function renderSubquery(value: { toSql(): Sql }): Sql {
  const inner = value.toSql();
  return sql`(${inner})`;
}

/**
 * A deferred `EXISTS (subquery)` / `NOT EXISTS (subquery)` condition.
 *
 * Users normally do not construct this directly — they call
 * `Expressions.exists(subQb)` / `Expressions.notExists(subQb)`.
 */
export class ExistsCondition implements ConditionLike {
  readonly __isCondition = true as const;
  readonly __isExistsCondition = true as const;

  constructor(
    readonly subquery: { toSql(): Sql },
    readonly negated: boolean,
  ) {}

  resolve(_resolveColumn: ColumnResolver, _dialect?: DialectExpression): Sql {
    const inner = this.subquery.toSql();
    return this.negated
      ? sql`NOT EXISTS (${inner})`
      : sql`EXISTS (${inner})`;
  }

  and(other: ConditionLike): ConditionLike {
    return LogicalComposer.and(this, other);
  }
  or(other: ConditionLike): ConditionLike {
    return LogicalComposer.or(this, other);
  }
  not(): ConditionLike {
    // Toggle the negated flag rather than nesting in NOT () for cleaner SQL.
    return new ExistsCondition(this.subquery, !this.negated);
  }
}

/** Type guard — true if `value` is an {@link ExistsCondition}. */
export function isExistsCondition(value: unknown): value is ExistsCondition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isExistsCondition?: unknown }).__isExistsCondition === true
  );
}

/**
 * @internal Indirection layer for logical composition, wired up from
 * {@link LogicalCondition} at module load time.
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

/** @internal Wire up composition. Called once from LogicalCondition.ts. */
export function registerExistsLogicalComposer(
  fns: LogicalComposerFns,
): void {
  LogicalComposer = fns;
}

/**
 * Factory — `EXISTS (subquery)`. Pass a `SelectQueryBuilder` (any
 * entity/result type); the builder is rendered at WHERE/HAVING-build
 * time, preserving all bound parameters.
 *
 * @example
 * ```ts
 * const active = em.createQueryBuilder(Post, "p")
 *   .select(["id"]).where(sql`"p"."author_id" = "u"."id"`);
 *
 * qb.where(Expressions.exists(active));
 * // WHERE EXISTS (SELECT "id" FROM "post" AS "p" WHERE "p"."author_id" = "u"."id")
 * ```
 */
export function exists(subquery: { toSql(): Sql }): ExistsCondition {
  if (!isSubqueryLike(subquery)) {
    throw new Error("exists() requires a SelectQueryBuilder-like argument.");
  }
  return new ExistsCondition(subquery, false);
}

/** Factory — `NOT EXISTS (subquery)`. Symmetric to {@link exists}. */
export function notExists(subquery: { toSql(): Sql }): ExistsCondition {
  if (!isSubqueryLike(subquery)) {
    throw new Error(
      "notExists() requires a SelectQueryBuilder-like argument.",
    );
  }
  return new ExistsCondition(subquery, true);
}
