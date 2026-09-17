/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "../utils/sqlTag";
import { Conditions } from "./Conditions";
import { WhereClause, FILTER_OPERATOR_KEYS } from "../dialects/FindOption";
import type { DialectExpression } from "../dialects/DialectExpression";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import { attachedWhereValueTransform } from "./WhereValueTransform";

/**
 * An operator whose operand is `undefined` has no sensible SQL: `eq` / `gt`
 * compared against NULL and matched nothing, `in` / `between` / `contains`
 * crashed with a TypeError, and `isNull` read the falsy operand as "IS NOT
 * NULL" and matched every non-null row.
 */
function undefinedOperandError(field: string, op: string): InvalidQueryError {
  return new InvalidQueryError(
    `Operator "${op}" on "${field}" received undefined.`,
    `Leave the operator out when its value is optional (e.g. { ...(min !== undefined && { gte: min }) }), or pass null where the operator accepts it (eq, ne, not).`,
  );
}

/**
 * Rejects an `undefined` element of an IN list. It binds as NULL, which never
 * matches, so the element was ignored without an error.
 */
function assertNoUndefinedElement(
  values: unknown,
  field: string,
  op: string,
): void {
  if (!Array.isArray(values)) return;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === undefined) {
      throw new InvalidQueryError(
        `The ${op} list for "${field}" contains undefined at index ${i}.`,
        "An undefined element binds as NULL and never matches, so it is ignored without an error. Filter the list before building the where.",
      );
    }
  }
}

/**
 * A branch that resolves to no condition is TRUE. Inside OR (or the array
 * form, which is OR-ed) that widens the whole group to every row, so it is
 * rejected. Before, it crashed inside `join([])` with a TypeError.
 */
function emptyOrBranchError(path: string): InvalidQueryError {
  return new InvalidQueryError(
    `The OR branch ${path} resolves to no condition, so the OR would match every row.`,
    "A branch that is empty or whose values are all undefined is always true. Remove the branch, or give it at least one defined value.",
  );
}

/**
 * `null` is a SQL NULL and a raw `sql` fragment is spliced as written: neither
 * is a domain value, so `transformer.to` never sees them.
 */
function isUntransformable(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === "object" && "sql" in (v as object))
  );
}

/**
 * Escape LIKE wildcard characters (`%`, `_`, `\`) in a literal string
 * so it can be safely used in `contains` / `startsWith` / `endsWith`.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/**
 * Check whether a plain object is a filter-operator object
 * (all keys are known operator names like `gt`, `like`, `in`, etc.).
 */
function isFilterObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  // Sql objects from sql-template-tag have a `sql` property
  if ("sql" in (value as any)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => FILTER_OPERATOR_KEYS.has(k));
}

/**
 * Resolve a single filter-operator object (e.g. `{ gt: 18, lte: 65 }`)
 * into one or more SQL conditions joined with AND.
 *
 * `field` names the where key in error messages; it defaults to `column`.
 */
function resolveFilterObject(
  column: string,
  filter: Record<string, any>,
  dialect?: string,
  dialectExpression?: DialectExpression,
  field: string = column,
  transformValue?: (field: string, value: unknown) => unknown,
): Sql {
  const clauses: Sql[] = [];
  const tv = (v: any): any =>
    transformValue && !isUntransformable(v) ? transformValue(field, v) : v;
  const tvAll = (v: any): any => (Array.isArray(v) ? v.map(tv) : v);

  for (const [op, val] of Object.entries(filter)) {
    if (val === undefined) throw undefinedOperandError(field, op);

    switch (op) {
      case "eq":
        // `eq: null` must become `IS NULL` — `col = NULL` is always UNKNOWN in
        // SQL's three-valued logic and silently matches nothing. Mirrors the
        // top-level `field: null` shorthand and `not: null` → IS NOT NULL.
        clauses.push(
          val === null
            ? Conditions.isNull(column)
            : Conditions.equals(column, tv(val)),
        );
        break;
      case "ne":
        // `ne: null` must become `IS NOT NULL` for the same reason.
        clauses.push(
          val === null
            ? Conditions.isNotNull(column)
            : Conditions.notEquals(column, tv(val)),
        );
        break;
      case "gt":
        clauses.push(Conditions.gt(column, tv(val)));
        break;
      case "gte":
        clauses.push(Conditions.gte(column, tv(val)));
        break;
      case "lt":
        clauses.push(Conditions.lt(column, tv(val)));
        break;
      case "lte":
        clauses.push(Conditions.lte(column, tv(val)));
        break;
      case "in":
        assertNoUndefinedElement(val, field, op);
        clauses.push(Conditions.in(column, tvAll(val)));
        break;
      case "notIn":
        assertNoUndefinedElement(val, field, op);
        clauses.push(Conditions.notIn(column, tvAll(val)));
        break;
      case "like":
        clauses.push(Conditions.like(column, val));
        break;
      case "notLike":
        clauses.push(Conditions.notLike(column, val));
        break;
      case "ilike":
        if (dialectExpression) {
          clauses.push(dialectExpression.ilike(column, val));
        } else {
          clauses.push(sql`${raw(column)} ILIKE ${val}`);
        }
        break;
      case "between":
        // A missing bound compared against NULL and matched nothing.
        if (!Array.isArray(val) || val[0] === undefined || val[1] === undefined) {
          const got = Array.isArray(val)
            ? `${val[0] === undefined ? "min" : "max"} is undefined`
            : `received ${val === null ? "null" : typeof val}`;
          throw new InvalidQueryError(
            `Operator "between" on "${field}" needs [min, max] with both bounds defined, but ${got}.`,
            "Use gte / lte for a range that is open on one side.",
          );
        }
        clauses.push(Conditions.between(column, tv(val[0]), tv(val[1])));
        break;
      case "isNull":
        clauses.push(
          val ? Conditions.isNull(column) : Conditions.isNotNull(column),
        );
        break;
      case "not":
        if (typeof val === "object" && val !== null && isFilterObject(val)) {
          const inner = resolveFilterObject(column, val, dialect, dialectExpression, field, transformValue);
          clauses.push(sql`NOT (${inner})`);
        } else if (val === null) {
          clauses.push(Conditions.isNotNull(column));
        } else {
          clauses.push(Conditions.notEquals(column, tv(val)));
        }
        break;
      case "contains":
        clauses.push(Conditions.like(column, `%${escapeLikePattern(val)}%`));
        break;
      case "startsWith":
        clauses.push(Conditions.like(column, `${escapeLikePattern(val)}%`));
        break;
      case "endsWith":
        clauses.push(Conditions.like(column, `%${escapeLikePattern(val)}`));
        break;
      case "search":
        if (dialectExpression) {
          clauses.push(dialectExpression.fullTextSearch(column, val));
        } else {
          clauses.push(Conditions.fullTextSearch(column, val, dialect));
        }
        break;
    }
  }

  return clauses.length === 1 ? clauses[0] : Conditions.and(clauses);
}

/**
 * Resolve a single where-field value into a parameterized SQL condition.
 *
 * Handles:
 * - `null` → IS NULL
 * - `[1,2,3]` (array) → IN
 * - `Sql` object → passed through (backward compat)
 * - filter object `{ gt: 18 }` → operator expansion
 * - plain value → equals
 *
 * `field` names the where key in error messages; it defaults to `column`.
 */
function resolveWhereValue(
  column: string,
  value: any,
  dialect?: string,
  dialectExpression?: DialectExpression,
  field: string = column,
  transformValue?: (field: string, value: unknown) => unknown,
): Sql {
  const tv = (v: any): any =>
    transformValue && !isUntransformable(v) ? transformValue(field, v) : v;
  if (value === null) {
    return Conditions.isNull(column);
  }
  if (Array.isArray(value)) {
    assertNoUndefinedElement(value, field, "IN");
    return Conditions.in(column, value.map(tv));
  }
  // Sql object from sql-template-tag (backward compat)
  if (typeof value === "object" && "sql" in value) {
    return value as Sql;
  }
  // Filter operator object
  if (typeof value === "object" && isFilterObject(value)) {
    return resolveFilterObject(column, value, dialect, dialectExpression, field, transformValue);
  }
  // Plain equality
  return Conditions.equals(column, tv(value));
}

/**
 * Options for {@link resolveWhereClause}.
 */
export interface WhereResolverOptions {
  /** Function to escape/quote a column identifier (e.g. wrapping in backticks or double quotes). */
  wrapColumn: (name: string) => string;
  /** If true, qualify column names with `tableName.column`. */
  qualified?: boolean;
  /** Table name to use when `qualified` is true. */
  tableName?: string;
  /** Dialect hint for dialect-specific operators like `search` (full-text). */
  dialect?: "mysql" | "postgres" | "sqlite";
  /** Maps TypeScript property names to database column names (for NamingStrategy support). */
  propertyToColumn?: Map<string, string>;
  /** Dialect expression strategy. When provided, takes precedence over dialect string for ilike/search. */
  dialectExpression?: DialectExpression;
  /**
   * Custom column qualification function. When provided and `qualified` is true,
   * this overrides the default `tableName.column` pattern.
   * Used by TPT inheritance to route columns to the correct table.
   */
  qualifyColumn?: (dbColumnName: string) => string;
  /**
   * Maps a comparison operand from its domain value to its stored value
   * (`transformer.to`). Applied to eq / ne / not / gt / gte / lt / lte /
   * in / notIn / between and the shorthand forms, per element. Pattern and
   * full-text operators, `null` and raw `sql` fragments are left as written.
   * Defaults to the transform attached to `propertyToColumn`.
   */
  transformValue?: (field: string, value: unknown) => unknown;
}

/**
 * Resolve a {@link WhereClause} (single object or array of objects)
 * into an array of parameterized `Sql` conditions.
 *
 * - Single object: each key-value pair produces an AND condition.
 * - Array: each element is AND-ed internally; elements are OR-ed together.
 * - `OR`, `AND`, `NOT` special keys are handled recursively.
 * - A top-level field or combinator set to `undefined` is skipped. An
 *   `undefined` operand, an `undefined` IN element and an OR branch (or
 *   array element) that resolves to no condition throw `InvalidQueryError`.
 */
export function resolveWhereClause<T>(
  where: WhereClause<T> | WhereClause<T>[] | undefined,
  opts: WhereResolverOptions,
): Sql[] {
  if (!where) return [];
  if (!opts.transformValue) {
    const transformValue = attachedWhereValueTransform(opts.propertyToColumn);
    if (transformValue) opts = { ...opts, transformValue };
  }

  // Array form: each element is AND-ed internally, elements OR-ed
  if (Array.isArray(where)) {
    const orGroups = (where as WhereClause<T>[]).map((clause, index) => {
      const subclauses = resolveWhereSingleObject(clause, opts);
      if (subclauses.length === 0) throw emptyOrBranchError(`[${index}]`);
      return subclauses.length === 1 ? subclauses[0] : Conditions.and(subclauses);
    });
    if (orGroups.length === 0) return [];
    if (orGroups.length === 1) return [orGroups[0]];
    return [Conditions.or(orGroups)];
  }

  return resolveWhereSingleObject(where, opts);
}

/**
 * Resolve a single WhereClause object into Sql[] conditions.
 */
function resolveWhereSingleObject<T>(
  where: WhereClause<T>,
  opts: WhereResolverOptions,
): Sql[] {
  const result: Sql[] = [];
  const { wrapColumn, qualified, tableName, dialect, dialectExpression } = opts;

  for (const key of Object.keys(where)) {
    const value = (where as any)[key];

    // Logical combinators. A combinator set to `undefined` is an absent key,
    // the same as a field set to `undefined`.
    if (key === "OR") {
      if (value === undefined) continue;
      const orClauses = (value as WhereClause<T>[]).map((clause, index) => {
        const sub = resolveWhereSingleObject(clause, opts);
        if (sub.length === 0) throw emptyOrBranchError(`OR[${index}]`);
        return sub.length === 1 ? sub[0] : Conditions.and(sub);
      });
      if (orClauses.length > 0) {
        result.push(Conditions.or(orClauses));
      }
      continue;
    }
    if (key === "AND") {
      if (value === undefined) continue;
      const andClauses: Sql[] = [];
      for (const clause of value as WhereClause<T>[]) {
        const sub = resolveWhereSingleObject(clause, opts);
        // An empty AND branch is TRUE, the identity of AND: skip it.
        if (sub.length === 0) continue;
        andClauses.push(sub.length === 1 ? sub[0] : Conditions.and(sub));
      }
      if (andClauses.length > 0) {
        result.push(Conditions.and(andClauses));
      }
      continue;
    }
    if (key === "NOT") {
      if (value === undefined) continue;
      const notSub = resolveWhereSingleObject(value as WhereClause<T>, opts);
      if (notSub.length > 0) {
        const inner =
          notSub.length === 1 ? notSub[0] : Conditions.and(notSub);
        result.push(sql`NOT (${inner})`);
      }
      continue;
    }

    // Skip undefined
    if (value === undefined) continue;

    // Regular field — resolve property name to DB column name via NamingStrategy map
    const dbColumnName = opts.propertyToColumn?.get(key) ?? key;
    const col =
      qualified && opts.qualifyColumn
        ? opts.qualifyColumn(dbColumnName)
        : qualified && tableName
          ? `${wrapColumn(tableName)}.${wrapColumn(dbColumnName)}`
          : wrapColumn(dbColumnName);

    result.push(
      resolveWhereValue(col, value, dialect, dialectExpression, key, opts.transformValue),
    );
  }

  return result;
}

export { isFilterObject, resolveFilterObject, resolveWhereValue, escapeLikePattern };
