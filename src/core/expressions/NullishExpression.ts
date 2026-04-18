/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "sql-template-tag";
import type { ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import { ScalarExpression } from "./ScalarExpression";
import {
  AggregateExpression,
  isAggregateExpression,
} from "./AggregateExpression";
import { isJsonPathExpression } from "./JsonPathExpression";
import { isScalarExpression } from "./ScalarExpression";

/**
 * Duck-type guard for `ColumnExpression` — defined inline here to avoid
 * an import cycle with `SelectQueryBuilder.ts`. `ColumnExpression`
 * carries an `__isColumnExpression` marker for exactly this purpose.
 */
function isColumnExpr(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isColumnExpression?: unknown }).__isColumnExpression === true
  );
}

/**
 * Inputs accepted by `coalesce()` / `nullif()`. Column and path
 * expressions resolve against the query builder's alias registry;
 * plain values are sent as bound parameters.
 */
export type NullishArg = ScalarExpression | AggregateExpression | unknown;

/**
 * @internal Render any accepted argument into a parameter-safe `Sql`
 * fragment. Keeps the coalesce/nullif builders small and aligns their
 * argument semantics: entity-aware references become qualified column
 * references, JSON paths delegate to the dialect's text extract, and
 * scalars go through standard placeholder binding.
 */
export function renderNullishArg(
  arg: NullishArg,
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
): Sql {
  if (isColumnExpr(arg)) {
    return sql`${raw(resolveColumn((arg as { toString(): string }).toString()))}`;
  }
  if (isAggregateExpression(arg)) {
    return (arg as AggregateExpression).renderFunction(resolveColumn);
  }
  if (isScalarExpression(arg)) {
    return (arg as ScalarExpression).renderer(resolveColumn, dialect);
  }
  if (isJsonPathExpression(arg)) {
    if (!dialect) {
      throw new Error(
        "JsonPathExpression inside coalesce()/nullif() requires a DialectExpression. " +
          "Ensure the query builder was created via EntityManager.createQueryBuilder().",
      );
    }
    const jp = arg as {
      _ref: string;
      _path: ReadonlyArray<string | number>;
      _meta?: import("../../dialects/DialectExpression").ColumnJsonMeta;
    };
    return dialect.jsonExtract(resolveColumn(jp._ref), jp._path, true, jp._meta);
  }
  return sql`${arg as any}`;
}

/**
 * Build a `COALESCE(a, b, c, …)` scalar expression.
 *
 * Accepts any mix of column references, scalar expressions, aggregates,
 * JSON path extractions, and plain values. The returned
 * {@link ScalarExpression} can be projected with `.as("alias")`,
 * compared with `.eq()` / `.gt()` / etc., and nested inside other
 * scalar expressions.
 *
 * Requires at least two arguments — a single-argument COALESCE is a
 * no-op that SQL engines typically reject.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * const display = coalesce(u.nickname, u.name, "anonymous");
 * qb.select([display.as("display_name")]);
 * ```
 */
export function coalesce(...args: NullishArg[]): ScalarExpression {
  if (args.length < 2) {
    throw new Error("coalesce() requires at least 2 arguments.");
  }
  const captured = args;
  return new ScalarExpression((resolveColumn, dialect) => {
    const parts = captured.map((a) =>
      renderNullishArg(a, resolveColumn, dialect),
    );
    return sql`COALESCE(${join(parts, ", ")})`;
  });
}

/**
 * Build a `NULLIF(a, b)` scalar expression — returns `NULL` when `a`
 * equals `b`, otherwise `a`. Useful for turning a sentinel value into
 * a real `NULL` (e.g. empty string → missing email).
 *
 * Both arguments accept column references, scalar expressions,
 * aggregates, JSON path extractions, and plain values.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * qb.select([nullif(u.email, "").as("email_or_null")]);
 * ```
 */
export function nullif(a: NullishArg, b: NullishArg): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const left = renderNullishArg(a, resolveColumn, dialect);
    const right = renderNullishArg(b, resolveColumn, dialect);
    return sql`NULLIF(${left}, ${right})`;
  });
}
