import type { Sql } from "sql-template-tag";
import type { DialectExpression } from "../../dialects/DialectExpression";

/**
 * Column resolver passed into {@link ConditionLike.resolve}.
 *
 * Accepts a deferred reference like `"u.firstName"` and returns the fully
 * qualified, escaped DB identifier (e.g. `"u"."first_name"`). The query
 * builder supplies this function at build time so conditions are free to
 * carry entity-property references without knowing the alias registry.
 */
export type ColumnResolver = (ref: string) => string;

/**
 * Common interface for all deferred QueryDSL conditions.
 *
 * Every condition object that can be passed to `.where()`, `.andWhere()`,
 * `.orWhere()`, or `.having()` implements this. It keeps dispatch simple —
 * the query builder only has to check `isConditionLike(x)` to decide
 * whether to call `.resolve()` instead of treating `x` as raw SQL.
 *
 * Implementers:
 * - `ColumnCondition` — basic column comparison (`u.age.gte(18)`)
 * - `JsonPathCondition` — JSON path expressions (`u.metadata.tags.contains(...)`)
 * - `AggregateCondition` — aggregate comparisons in HAVING (`u.id.count().gt(10)`)
 * - `LogicalCondition` — AND / OR / NOT of other ConditionLike instances
 */
export interface ConditionLike {
  readonly __isCondition: true;
  resolve(resolveColumn: ColumnResolver, dialect?: DialectExpression): Sql;
}

/** Type guard — true if `value` exposes the {@link ConditionLike} shape. */
export function isConditionLike(value: unknown): value is ConditionLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isCondition?: unknown }).__isCondition === true
  );
}
