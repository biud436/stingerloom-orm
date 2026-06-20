import type { Sql } from "sql-template-tag";
import { ScalarExpression } from "./ScalarExpression";

/**
 * Wrap a raw `Sql` fragment as a typed {@link ScalarExpression}.
 *
 * The escape hatch for anything the typed builder does not cover
 * directly — `EXTRACT(epoch FROM ...)`, vendor-specific functions,
 * full-text `to_tsquery(...)`, etc. — while preserving composability
 * with the rest of the Tier 2/3 expression surface.
 *
 * The generic `T` is a TypeScript marker only: it documents the
 * intended SQL return type and flows through downstream chains (e.g.
 * `rawInt.gt(0)` type-checks against the intent of the raw SQL), but
 * it is not enforced at runtime.
 *
 * ⚠ Callers take responsibility for the safety of the raw SQL.
 * Column references, table aliases, and any user-supplied values must
 * be passed as bound parameters through `sql-template-tag`
 * interpolation — `sql`EXTRACT(epoch FROM ${col})`` — not inlined as
 * strings.
 *
 * @example
 * ```ts
 * import sql from "sql-template-tag";
 * import { Expressions, qAlias } from "@stingerloom/orm";
 *
 * const u = qAlias(User, "u");
 * const epoch = Expressions.raw<number>(
 *   sql`EXTRACT(epoch FROM ${u.col("createdAt")})`,
 * );
 *
 * qb.select([epoch.as("epoch_s")])
 *   .where(epoch.gt(1700000000));
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function rawExpr<_T = unknown>(fragment: Sql): ScalarExpression {
  return new ScalarExpression(() => fragment);
}
