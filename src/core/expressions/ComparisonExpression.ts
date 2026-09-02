import type { ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import { ScalarExpression } from "./ScalarExpression";
import { renderNullishArg, type NullishArg } from "./NullishExpression";

/**
 * Inputs accepted by `greatest()` / `least()` — the same union
 * `coalesce()` takes. Column and path expressions resolve against the
 * builder's alias registry; plain values are sent as bound parameters.
 */
export type ComparisonArg = NullishArg;

/**
 * @internal Shared body for {@link greatest} and {@link least}: both take
 * two or more arguments, render each through the nullish-arg resolver, and
 * hand the fragments to the dialect. Only the dialect method differs.
 */
function buildRowWiseComparison(
  fnName: "greatest" | "least",
  args: ComparisonArg[],
): ScalarExpression {
  if (args.length < 2) {
    throw new Error(`${fnName}() requires at least 2 arguments.`);
  }
  const captured = args;
  return new ScalarExpression(
    (resolveColumn: ColumnResolver, dialect?: DialectExpression) => {
      if (!dialect) {
        throw new Error(
          `${fnName}() requires a DialectExpression — SQLite spells the ` +
            "row-wise maximum MAX(a, b) while PostgreSQL and MySQL spell it " +
            "GREATEST(a, b). Ensure the builder was created via " +
            "EntityManager.createQueryBuilder() / createInsertBuilder().",
        );
      }
      const parts = captured.map((a) =>
        renderNullishArg(a, resolveColumn, dialect),
      );
      return dialect[fnName](parts);
    },
  );
}

/**
 * Build a row-wise `GREATEST(a, b, …)` scalar expression — the largest of
 * the arguments **within one row**, which is a different thing from the
 * `MAX()` aggregate over rows.
 *
 * Accepts any mix of column references, scalar expressions, aggregates,
 * JSON path extractions, and plain values, and returns a
 * {@link ScalarExpression} that can be projected with `.as("alias")`,
 * compared with `.gt()` / `.eq()`, or nested in another expression.
 *
 * Requires at least two arguments.
 *
 * **NULL handling is not portable.** PostgreSQL ignores NULL arguments;
 * MySQL/MariaDB and SQLite return NULL when any argument is NULL. Wrap the
 * nullable arguments in `coalesce()` if the query must behave identically
 * on every engine.
 *
 * @example Keep the later of two timestamps in an upsert
 * ```ts
 * await em.createInsertBuilder(SyncMarker)
 *   .values(rows)
 *   .onConflict(["mac", "bucketStart"])
 *   .doUpdate((t, ex) => ({
 *     lastTime: greatest(t.lastTime, ex.lastTime),
 *   }))
 *   .execute();
 * ```
 */
export function greatest(...args: ComparisonArg[]): ScalarExpression {
  return buildRowWiseComparison("greatest", args);
}

/**
 * Build a row-wise `LEAST(a, b, …)` scalar expression — the counterpart to
 * {@link greatest}, with the same argument union and the same engine-specific
 * NULL handling.
 *
 * Requires at least two arguments.
 *
 * @example
 * ```ts
 * const o = qAlias(Order, "o");
 * qb.select([least(o.listPrice, o.promoPrice).as("charged")]);
 * ```
 */
export function least(...args: ComparisonArg[]): ScalarExpression {
  return buildRowWiseComparison("least", args);
}
