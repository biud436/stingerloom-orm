import sql, { raw } from "sql-template-tag";
import type {
  DateComponent,
  DialectExpression,
} from "../../dialects/DialectExpression";
import type { Sql } from "sql-template-tag";
import type { ColumnResolver } from "./ConditionLike";
import { ScalarExpression } from "./ScalarExpression";

/**
 * @internal Build a date-component scalar expression around a
 * pre-rendered inner value. Used by `.year()` / `.month()` / etc.
 * helpers on both {@link ColumnExpression} and {@link ScalarExpression}.
 */
export function buildDateComponent(
  component: DateComponent,
  inner: (resolveColumn: ColumnResolver, dialect?: DialectExpression) => Sql,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    if (!dialect) {
      throw new Error(
        "Date component expressions require a DialectExpression. " +
          "Ensure the query builder was created via EntityManager.createQueryBuilder().",
      );
    }
    const value = inner(resolveColumn, dialect);
    return dialect.dateComponent(value, component);
  });
}

/** @internal shared for column-ref based date component helpers. */
export function buildDateComponentFromRef(
  component: DateComponent,
  ref: string,
): ScalarExpression {
  return buildDateComponent(component, (resolveColumn) =>
    sql`${raw(resolveColumn(ref))}`,
  );
}
