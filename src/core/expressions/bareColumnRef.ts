import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import type { ColumnResolver } from "./ConditionLike";

/**
 * A bare column reference: an identifier, optionally dot-qualified once —
 * `property` or `alias.property`. Anything outside this shape carries SQL
 * syntax (a function call, an operator, `*`, whitespace, quotes, a comma)
 * and is therefore an expression, not a reference.
 */
const BARE_COLUMN_REF = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * @internal Is `token` a bare column reference (`prop` / `alias.prop`)
 * rather than a SQL expression? Leading / trailing whitespace is ignored.
 */
export function isBareColumnRef(token: string): boolean {
  return BARE_COLUMN_REF.test(token.trim());
}

/**
 * @internal The one rule every string slot of the SELECT query builder that
 * also accepts expressions applies — `selectRaw()`, `addSelect()`,
 * `groupBy()`, `addOrderBy()` and the window `partitionBy()`:
 *
 * - a **bare column reference** is resolved through `resolve` (property →
 *   DB column via NamingStrategy / `@Column({ name })`, alias registry
 *   lookup, identifier quoting, TPT parent routing);
 * - **anything else** is an expression the caller wrote and is emitted
 *   verbatim, trimmed. Routing it through the resolver used to mangle it
 *   into a single quoted identifier (`"r"."UPPER(grp)"`) that only failed
 *   inside the driver.
 *
 * An empty / blank string is rejected up front — it can be neither, and
 * letting it through only produces a bare SQL syntax error later.
 *
 * SECURITY: the verbatim branch is a raw-SQL channel, exactly as
 * `selectRaw()` has always been. Expression strings must be program
 * literals — never assemble them from untrusted input. Values belong in
 * bound parameters (`sql` template interpolation, `ScalarExpression`
 * renderers); a bare reference by definition cannot carry one, and nothing
 * on this path is ever bound.
 *
 * @param clause Name of the calling API, used in the error message.
 */
export function resolveColumnOrExpression(
  token: string,
  resolve: ColumnResolver,
  clause: string,
): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new OrmError(
      OrmErrorCode.INVALID_QUERY,
      `${clause}: empty string entry. Pass a column reference ("prop" / "alias.prop") or a SQL expression.`,
    );
  }
  return BARE_COLUMN_REF.test(trimmed) ? resolve(trimmed) : trimmed;
}
