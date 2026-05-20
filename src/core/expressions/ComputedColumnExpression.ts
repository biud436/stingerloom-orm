import sql, { Sql, raw } from "sql-template-tag";
import type { DialectName } from "../ColumnTypeRegistry";
import { createDialectExpression } from "../../dialects/DialectExpression";
import { escapeSqlLiteral } from "../../utils/escapeSqlLiteral";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import type { ColumnResolver, ConditionLike } from "./ConditionLike";
import { isConditionLike } from "./ConditionLike";
import { ScalarExpression, isScalarExpression } from "./ScalarExpression";
import { Expressions } from "./LogicalCondition";

/**
 * The `e` context handed to a `@ComputedColumn` expression builder.
 *
 * Exposes the full `Expressions.*` DSL (`iff`, `caseBuilder`, `dateDiff`,
 * `coalesce`, …) plus `col(name)` for referencing a sibling column of the
 * same table. The builder is invoked once per connection at schema-generation
 * time, so a single definition renders dialect-correct DDL on MySQL,
 * PostgreSQL, and SQLite alike — with no `process.env` access.
 */
export type ComputedColumnExpressionContext = typeof Expressions & {
  /**
   * Reference a sibling column by its database column name (the
   * post-NamingStrategy name — the same name you would write in a literal
   * expression string). Produces a {@link ScalarExpression} usable anywhere
   * the DSL accepts a column.
   */
  col(name: string): ScalarExpression;
};

/**
 * Builder form of `@ComputedColumn({ expression })`. Receives the
 * {@link ComputedColumnExpressionContext} and returns a single SQL
 * expression (or a boolean condition, for a boolean generated column).
 *
 * @example
 * ```ts
 * @ComputedColumn({
 *   expression: (e) =>
 *     e.iff(
 *       e.col("deleted_at").isNull().and(e.col("completed_at").isNotNull()),
 *       e.dateDiff(e.col("completed_at"), e.col("created_at"), "hour"),
 *       null,
 *     ),
 *   type: "int",
 *   nullable: true,
 * })
 * cycleTimeHours?: number;
 * ```
 */
export type ComputedColumnExpressionBuilder = (
  e: ComputedColumnExpressionContext,
) => ScalarExpression | ConditionLike;

/**
 * The shared `e` context. `col()` defers identifier resolution to the
 * {@link ColumnResolver} passed at render time, so the object is stateless
 * and serves every entity and dialect. Built lazily to stay clear of the
 * `LogicalCondition` ↔ `ScalarExpression` module-init cycle.
 */
let cachedContext: ComputedColumnExpressionContext | undefined;

function getContext(): ComputedColumnExpressionContext {
  if (!cachedContext) {
    cachedContext = {
      ...Expressions,
      col(name: string): ScalarExpression {
        return new ScalarExpression((resolveColumn) =>
          sql`${raw(resolveColumn(name))}`,
        );
      },
    };
  }
  return cachedContext;
}

/**
 * Render a `@ComputedColumn` expression builder into a literal SQL string
 * suitable for embedding in a `GENERATED ALWAYS AS (...)` DDL clause.
 *
 * Generated-column expressions cannot carry bind parameters, so any value
 * the DSL would normally bind (a `CASE … ELSE null`, a numeric/string
 * constant) is inlined as a SQL literal — strings via {@link escapeSqlLiteral}.
 *
 * @param builder       The user-supplied expression builder.
 * @param dialect       The target driver — selects the `DialectExpression`.
 * @param resolveColumn Maps an `e.col(name)` reference to an escaped identifier.
 */
export function renderComputedColumnExpression(
  builder: ComputedColumnExpressionBuilder,
  dialect: DialectName,
  resolveColumn: ColumnResolver,
): string {
  const result = builder(getContext());
  const dialectExpr = createDialectExpression(dialect);

  let rendered: Sql;
  if (isScalarExpression(result)) {
    rendered = result.renderer(resolveColumn, dialectExpr);
  } else if (isConditionLike(result)) {
    rendered = result.resolve(resolveColumn, dialectExpr);
  } else {
    throw new OrmError(
      OrmErrorCode.VALIDATION_ERROR,
      "@ComputedColumn expression builder must return a value built from " +
        "the provided context — e.col(...), e.iff(...), e.dateDiff(...), " +
        "e.caseBuilder()…end(), or a comparison such as e.col(...).gt(0).",
    );
  }

  return inlineSql(rendered, dialect);
}

/** Splice a flattened `Sql` into a literal string, inlining every bound value. */
function inlineSql(fragment: Sql, dialect: DialectName): string {
  const { strings, values } = fragment;
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += toSqlLiteral(values[i], dialect) + strings[i + 1];
  }
  return out.trim();
}

/** Convert a single bound value into an inline SQL literal. */
function toSqlLiteral(value: unknown, dialect: DialectName): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OrmError(
        OrmErrorCode.VALIDATION_ERROR,
        `@ComputedColumn expression produced a non-finite number (${value}); ` +
          "it cannot be inlined into DDL.",
      );
    }
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") {
    return dialect === "mysql" ? (value ? "1" : "0") : value ? "TRUE" : "FALSE";
  }
  if (typeof value === "string") return `'${escapeSqlLiteral(value)}'`;
  throw new OrmError(
    OrmErrorCode.VALIDATION_ERROR,
    `@ComputedColumn expression produced a ${typeof value} value that cannot ` +
      "be inlined into a GENERATED ALWAYS AS (...) clause. Use column " +
      "references (e.col), numbers, strings, booleans, or null.",
  );
}
