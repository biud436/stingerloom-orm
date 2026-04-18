import sql from "sql-template-tag";
import { ScalarExpression } from "./ScalarExpression";

/**
 * `CURRENT_DATE` — the database server's current date (no time
 * component), as a {@link ScalarExpression} that slots into SELECT,
 * WHERE, HAVING, and ORDER BY.
 *
 * Standard SQL; every supported dialect emits the same literal.
 *
 * @example
 * ```ts
 * qb.where(u.createdAt.gte(Expressions.currentDate()));
 * ```
 */
export function currentDate(): ScalarExpression {
  return new ScalarExpression(() => sql`CURRENT_DATE`);
}

/**
 * `CURRENT_TIME` — the database server's current time (no date
 * component), as a {@link ScalarExpression}.
 */
export function currentTime(): ScalarExpression {
  return new ScalarExpression(() => sql`CURRENT_TIME`);
}

/**
 * `CURRENT_TIMESTAMP` — the database server's current date+time, as a
 * {@link ScalarExpression}. Most common of the three; use it for
 * "now()"-style comparisons.
 *
 * @example
 * ```ts
 * qb.where(u.expiresAt.lte(Expressions.currentTimestamp()));
 * ```
 */
export function currentTimestamp(): ScalarExpression {
  return new ScalarExpression(() => sql`CURRENT_TIMESTAMP`);
}
