/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "sql-template-tag";
import { Conditions } from "./Conditions";
import { WhereClause, FILTER_OPERATOR_KEYS } from "../dialects/FindOption";
import type { DialectExpression } from "../dialects/DialectExpression";

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
 */
function resolveFilterObject(
  column: string,
  filter: Record<string, any>,
  dialect?: string,
  dialectExpression?: DialectExpression,
): Sql {
  const clauses: Sql[] = [];

  for (const [op, val] of Object.entries(filter)) {
    switch (op) {
      case "eq":
        // `eq: null` must become `IS NULL` — `col = NULL` is always UNKNOWN in
        // SQL's three-valued logic and silently matches nothing. Mirrors the
        // top-level `field: null` shorthand and `not: null` → IS NOT NULL.
        clauses.push(
          val === null
            ? Conditions.isNull(column)
            : Conditions.equals(column, val),
        );
        break;
      case "ne":
        // `ne: null` must become `IS NOT NULL` for the same reason.
        clauses.push(
          val === null
            ? Conditions.isNotNull(column)
            : Conditions.notEquals(column, val),
        );
        break;
      case "gt":
        clauses.push(Conditions.gt(column, val));
        break;
      case "gte":
        clauses.push(Conditions.gte(column, val));
        break;
      case "lt":
        clauses.push(Conditions.lt(column, val));
        break;
      case "lte":
        clauses.push(Conditions.lte(column, val));
        break;
      case "in":
        clauses.push(Conditions.in(column, val));
        break;
      case "notIn":
        clauses.push(Conditions.notIn(column, val));
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
        clauses.push(Conditions.between(column, val[0], val[1]));
        break;
      case "isNull":
        clauses.push(
          val ? Conditions.isNull(column) : Conditions.isNotNull(column),
        );
        break;
      case "not":
        if (typeof val === "object" && val !== null && isFilterObject(val)) {
          const inner = resolveFilterObject(column, val, dialect, dialectExpression);
          clauses.push(sql`NOT (${inner})`);
        } else if (val === null) {
          clauses.push(Conditions.isNotNull(column));
        } else {
          clauses.push(Conditions.notEquals(column, val));
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
 */
function resolveWhereValue(
  column: string,
  value: any,
  dialect?: string,
  dialectExpression?: DialectExpression,
): Sql {
  if (value === null) {
    return Conditions.isNull(column);
  }
  if (Array.isArray(value)) {
    return Conditions.in(column, value);
  }
  // Sql object from sql-template-tag (backward compat)
  if (typeof value === "object" && "sql" in value) {
    return value as Sql;
  }
  // Filter operator object
  if (typeof value === "object" && isFilterObject(value)) {
    return resolveFilterObject(column, value, dialect, dialectExpression);
  }
  // Plain equality
  return Conditions.equals(column, value);
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
}

/**
 * Resolve a {@link WhereClause} (single object or array of objects)
 * into an array of parameterized `Sql` conditions.
 *
 * - Single object: each key-value pair produces an AND condition.
 * - Array: each element is AND-ed internally; elements are OR-ed together.
 * - `OR`, `AND`, `NOT` special keys are handled recursively.
 */
export function resolveWhereClause<T>(
  where: WhereClause<T> | WhereClause<T>[] | undefined,
  opts: WhereResolverOptions,
): Sql[] {
  if (!where) return [];

  // Array form: each element is AND-ed internally, elements OR-ed
  if (Array.isArray(where)) {
    const orGroups = (where as WhereClause<T>[]).map((clause) => {
      const subclauses = resolveWhereSingleObject(clause, opts);
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

    // Logical combinators
    if (key === "OR") {
      const orClauses = (value as WhereClause<T>[]).map((clause) => {
        const sub = resolveWhereSingleObject(clause, opts);
        return sub.length === 1 ? sub[0] : Conditions.and(sub);
      });
      if (orClauses.length > 0) {
        result.push(Conditions.or(orClauses));
      }
      continue;
    }
    if (key === "AND") {
      const andClauses = (value as WhereClause<T>[]).map((clause) => {
        const sub = resolveWhereSingleObject(clause, opts);
        return sub.length === 1 ? sub[0] : Conditions.and(sub);
      });
      if (andClauses.length > 0) {
        result.push(Conditions.and(andClauses));
      }
      continue;
    }
    if (key === "NOT") {
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

    result.push(resolveWhereValue(col, value, dialect, dialectExpression));
  }

  return result;
}

export { isFilterObject, resolveFilterObject, resolveWhereValue, escapeLikePattern };
