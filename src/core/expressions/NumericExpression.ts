import sql, { Sql, raw } from "sql-template-tag";
import type { DialectExpression } from "../../dialects/DialectExpression";
import type { ColumnResolver } from "./ConditionLike";
import { ScalarExpression } from "./ScalarExpression";
import type { InnerRenderer } from "./StringExpression";
import { renderStringArg } from "./StringExpression";

/**
 * Build a binary-operator scalar: `(left <op> right)`. Used by `.add`
 * / `.sub` / `.mul` / `.div` / `.mod`.
 */
function buildBinaryOp(
  inner: InnerRenderer,
  op: string,
  right: unknown,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const left = inner(resolveColumn, dialect);
    const r = renderStringArg(right, resolveColumn, dialect);
    return sql`(${left} ${raw(op)} ${r})`;
  });
}

export function buildAdd(inner: InnerRenderer, r: unknown): ScalarExpression {
  return buildBinaryOp(inner, "+", r);
}
export function buildSub(inner: InnerRenderer, r: unknown): ScalarExpression {
  return buildBinaryOp(inner, "-", r);
}
export function buildMul(inner: InnerRenderer, r: unknown): ScalarExpression {
  return buildBinaryOp(inner, "*", r);
}
export function buildDiv(inner: InnerRenderer, r: unknown): ScalarExpression {
  return buildBinaryOp(inner, "/", r);
}
/**
 * `(x % y)` — standard SQL on PostgreSQL / SQLite; MySQL also accepts
 * `%` as a MOD operator. Result semantics match JS `%` for positive
 * operands; for negative values, SQL engines differ (MySQL/SQLite
 * match JS, PostgreSQL returns the sign of the dividend).
 */
export function buildMod(inner: InnerRenderer, r: unknown): ScalarExpression {
  return buildBinaryOp(inner, "%", r);
}
/** `-x` — unary minus. */
export function buildNeg(inner: InnerRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    return sql`(-${v})`;
  });
}

// ── Math functions ─────────────────────────────────────

/** `ABS(x)`. */
export function buildAbs(inner: InnerRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    return sql`ABS(${inner(resolveColumn, dialect)})`;
  });
}
/** `FLOOR(x)`. */
export function buildFloor(inner: InnerRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    return sql`FLOOR(${inner(resolveColumn, dialect)})`;
  });
}
/**
 * `CEIL(x)` — MySQL, PostgreSQL, and SQLite (SQLite 3.35+) all accept
 * `CEIL`. Older SQLite may require `CEILING` or a compile flag; this
 * helper uses `CEIL` which matches PostgreSQL and MySQL docs.
 */
export function buildCeil(inner: InnerRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    return sql`CEIL(${inner(resolveColumn, dialect)})`;
  });
}
/**
 * `ROUND(x)` or `ROUND(x, digits)`. Positive `digits` rounds to that
 * many decimal places; 0 (default) rounds to integer.
 */
export function buildRound(
  inner: InnerRenderer,
  digits: number | undefined,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    if (digits === undefined) {
      return sql`ROUND(${v})`;
    }
    return sql`ROUND(${v}, ${digits})`;
  });
}
/** `SQRT(x)`. */
export function buildSqrt(inner: InnerRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    return sql`SQRT(${inner(resolveColumn, dialect)})`;
  });
}
