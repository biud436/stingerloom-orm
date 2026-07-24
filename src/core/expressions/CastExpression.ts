import sql, { Sql, raw } from "../../utils/sqlTag";
import type { CastKind, DialectExpression } from "../../dialects/DialectExpression";
import type { ColumnResolver } from "./ConditionLike";
import { ScalarExpression } from "./ScalarExpression";

/**
 * @internal Build a `CAST(<inner> AS <type>)` scalar expression around
 * a pre-rendered inner SQL fragment. Used by `.stringValue()` /
 * `.intValue()` / etc. helpers on both {@link ColumnExpression} and
 * {@link ScalarExpression}.
 */
export function buildCastScalar(
  kind: CastKind,
  inner: (resolveColumn: ColumnResolver, dialect?: DialectExpression) => Sql,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    if (!dialect) {
      throw new Error(
        "CAST expressions require a DialectExpression. Ensure the query " +
          "builder was created via EntityManager.createQueryBuilder().",
      );
    }
    const value = inner(resolveColumn, dialect);
    const typeName = dialect.castTypeName(kind);
    return sql`CAST(${value} AS ${raw(typeName)})`;
  });
}
