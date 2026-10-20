/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "../../utils/sqlTag";
import type { DialectExpression } from "../../dialects/DialectExpression";
import type { ColumnResolver } from "./ConditionLike";

/**
 * @internal The SQL of an expression passed as an argument: a scalar
 * expression renders itself, a column expression resolves to its qualified
 * column. `undefined` when `arg` is neither.
 *
 * Both are recognised by their markers rather than by class, so this module
 * imports neither class and every expression module can depend on it.
 */
export function renderExpression(
  arg: unknown,
  resolveColumn: ColumnResolver,
  dialect: DialectExpression | undefined,
): Sql | undefined {
  if (arg === null || typeof arg !== "object") return undefined;
  const marked = arg as {
    __isScalarExpression?: unknown;
    __isColumnExpression?: unknown;
  };
  if (marked.__isScalarExpression === true) {
    return (arg as {
      renderer: (r: ColumnResolver, d?: DialectExpression) => Sql;
    }).renderer(resolveColumn, dialect);
  }
  if (marked.__isColumnExpression === true) {
    return sql`${raw(resolveColumn((arg as { toString(): string }).toString()))}`;
  }
  return undefined;
}

/**
 * @internal Render an argument of an expression helper. An expression
 * renders as in {@link renderExpression}; anything else is a value bound as
 * a parameter — except that with `strings: "column"` a string names a column
 * (`"alias.prop"`) and resolves like one.
 */
export function renderExpressionArg(
  arg: unknown,
  resolveColumn: ColumnResolver,
  dialect: DialectExpression | undefined,
  strings: "value" | "column" = "value",
): Sql {
  const expression = renderExpression(arg, resolveColumn, dialect);
  if (expression) return expression;
  if (strings === "column" && typeof arg === "string") {
    return sql`${raw(resolveColumn(arg))}`;
  }
  return sql`${arg as any}`;
}
