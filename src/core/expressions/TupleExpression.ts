import sql, { Sql, join, raw, type RawValue } from "../../utils/sqlTag";
import type { ConditionLike, ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

/**
 * A column reference inside a tuple — either a `qAlias()` column expression
 * (duck-typed by its `toString()`) or a raw `"alias.prop"` string. Kept
 * structural so this module needs no import of `ColumnExpression` (which
 * lives in `SelectQueryBuilder` and would form an import cycle).
 */
export type TupleColumn = string | { toString(): string };

function refOf(col: TupleColumn): string {
  return typeof col === "string" ? col : col.toString();
}

/**
 * A SQL row-value (tuple) constructor — `(c1, c2, …)` — that compares
 * several columns against value tuples in one predicate.
 *
 * The natural fit for composite-PK entities: instead of unrolling
 * `(a = ? AND b = ?) OR (a = ? AND b = ?)`, express it as a single
 * `(a, b) IN ((?, ?), (?, ?))`. Row-value comparison is native on
 * PostgreSQL, MySQL, and SQLite (≥ 3.15).
 *
 * Created via {@link tuple} / `Expressions.tuple(...)`.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * qb.where(
 *   Expressions.tuple(u.tenantId, u.userId).in([
 *     [1, "alice"],
 *     [1, "bob"],
 *     [2, "carol"],
 *   ]),
 * );
 * // (tenant_id, user_id) IN ((?, ?), (?, ?), (?, ?))
 * ```
 */
export class TupleExpression {
  readonly __isTupleExpression = true as const;

  constructor(readonly columns: ReadonlyArray<TupleColumn>) {
    if (columns.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "Expressions.tuple() requires at least one column.",
      );
    }
  }

  /** `(c1, c2, …) IN ((v11, v12, …), …)` — match any of the value rows. */
  in(rows: ReadonlyArray<ReadonlyArray<unknown>>): TupleCondition {
    return new TupleCondition(this.columns, "IN", rows);
  }

  /** `(c1, c2, …) NOT IN ((v11, v12, …), …)` — match none of the value rows. */
  notIn(rows: ReadonlyArray<ReadonlyArray<unknown>>): TupleCondition {
    return new TupleCondition(this.columns, "NOT IN", rows);
  }

  /** `(c1, c2, …) = (v1, v2, …)` — equality against a single value row. */
  eq(row: ReadonlyArray<unknown>): TupleCondition {
    return new TupleCondition(this.columns, "=", [row]);
  }
}

/** Operators a {@link TupleCondition} can carry. */
export type TupleOperator = "IN" | "NOT IN" | "=";

/**
 * A deferred row-value comparison condition. Implements {@link ConditionLike}
 * so it composes through `where()` / `andWhere()` / `having()` and the
 * `Expressions.and` / `.or` / `.not` static helpers.
 */
export class TupleCondition implements ConditionLike {
  readonly __isCondition = true as const;
  readonly __isTupleCondition = true as const;

  constructor(
    readonly columns: ReadonlyArray<TupleColumn>,
    readonly operator: TupleOperator,
    readonly rows: ReadonlyArray<ReadonlyArray<unknown>>,
  ) {
    const arity = columns.length;
    for (const row of rows) {
      if (row.length !== arity) {
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          `Tuple row-value comparison arity mismatch: ${arity} column(s) but a ` +
            `value row has ${row.length}. Every row must match the column count.`,
        );
      }
    }
    if (operator === "=" && rows.length !== 1) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "Tuple .eq() compares against exactly one value row.",
      );
    }
  }

  resolve(resolveColumn: ColumnResolver, _dialect?: DialectExpression): Sql {
    const lhs = sql`(${join(
      this.columns.map((c) => raw(resolveColumn(refOf(c)))),
      ", ",
    )})`;

    if (this.operator === "=") {
      const row = this.rows[0];
      return sql`${lhs} = (${join(
        row.map((v) => sql`${v as RawValue}`),
        ", ",
      )})`;
    }

    // IN / NOT IN. An empty row list degenerates to a constant predicate,
    // mirroring the scalar `Conditions.in` / `notIn` guard: IN matches
    // nothing (`1 = 0`), NOT IN excludes nothing (`1 = 1`).
    if (this.rows.length === 0) {
      return this.operator === "IN" ? sql`1 = 0` : sql`1 = 1`;
    }

    const rowFragments = this.rows.map(
      (row) =>
        sql`(${join(
          row.map((v) => sql`${v as RawValue}`),
          ", ",
        )})`,
    );
    return sql`${lhs} ${raw(this.operator)} (${join(rowFragments, ", ")})`;
  }
}

/**
 * Factory for {@link TupleExpression}. Surfaced as `Expressions.tuple(...)`.
 *
 * @param columns - Two or more column references (`qAlias()` columns or
 *                  `"alias.prop"` strings). A single column is allowed but
 *                  is just `(c) IN ((v), …)`.
 */
export function tuple(...columns: TupleColumn[]): TupleExpression {
  return new TupleExpression(columns);
}

/** Type guard — true if `value` is a {@link TupleCondition}. */
export function isTupleCondition(value: unknown): value is TupleCondition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isTupleCondition?: unknown }).__isTupleCondition === true
  );
}
