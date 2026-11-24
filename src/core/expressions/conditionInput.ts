import { isSqlFragment, type Sql } from "../../utils/sqlTag";
import type { DialectExpression } from "../../dialects/DialectExpression";
import { InvalidQueryError } from "../../errors/InvalidQueryError";
import { isConditionLike, type ColumnResolver } from "./ConditionLike";

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") {
    const name = (value as object).constructor?.name;
    return name && name !== "Object" ? `a ${name} instance` : "a plain object";
  }
  return `the ${typeof value} ${String(value)}`;
}

/**
 * @internal Turns the argument of a builder's condition slot into SQL.
 *
 * A condition slot takes a `sql` fragment or a QueryDSL condition. Anything
 * else — a find-style where object, a string of SQL, `undefined` from a
 * conditional expression — used to be handed to the statement as if it were
 * a fragment, which either broke the parameter binding or produced a
 * statement that filtered on nothing (or on everything). It is refused here
 * instead, before any SQL is built.
 *
 * @param slot the call the argument was given to, e.g. `UpdateQueryBuilder.where()`
 */
export function resolveConditionInput(
  condition: unknown,
  slot: string,
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
): Sql {
  if (isConditionLike(condition)) {
    return condition.resolve(resolveColumn, dialect);
  }
  if (isSqlFragment(condition)) return condition;
  throw new InvalidQueryError(
    `${slot} takes a sql\`\` fragment or a QueryDSL condition, but received ${describe(condition)}.`,
    typeof condition === "string"
      ? "Wrap raw SQL in the sql tag (sql`id = ${id}`) so values are bound, or build the condition with qAlias()."
      : "Pass a sql`` fragment (sql`id = ${id}`) or a QueryDSL condition (qAlias(Entity, \"e\").id.eq(id)). Skip the call when there is nothing to filter on.",
  );
}
