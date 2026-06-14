/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, join, raw } from "sql-template-tag";
import type { FullTextSearchOptions } from "../dialects/DialectExpression";

export class Conditions {
  /**
   * Creates a condition that checks if a column equals a specific value.
   */
  static equals(column: string, value: any): Sql {
    return sql`${raw(column)} = ${value}`;
  }

  /**
   * Creates a condition that checks if a column does not equal a specific value.
   */
  static notEquals(column: string, value: any): Sql {
    return sql`${raw(column)} != ${value}`;
  }

  /**
   * Creates a condition that checks if a column matches one of the specified values.
   *
   * An empty `values` array is a logical "matches nothing", so we emit `1 = 0`
   * instead of forwarding it to `join([])`, which throws a `TypeError`.
   */
  static in(column: string, values: any[]): Sql {
    if (values.length === 0) {
      return sql`1 = 0`;
    }
    return sql`${raw(column)} IN (${join(
      values.map((v) => sql`${v}`),
      ", ",
    )})`;
  }

  /**
   * Creates a condition that checks if a column does not match any of the specified values.
   *
   * An empty `values` array excludes nothing, so we emit `1 = 1` instead of
   * forwarding it to `join([])`, which throws a `TypeError`.
   */
  static notIn(column: string, values: any[]): Sql {
    if (values.length === 0) {
      return sql`1 = 1`;
    }
    return sql`${raw(column)} NOT IN (${join(
      values.map((v) => sql`${v}`),
      ", ",
    )})`;
  }

  /**
   * Creates a condition that checks if a column matches a specific pattern.
   */
  static like(column: string, pattern: string): Sql {
    return sql`${raw(column)} LIKE ${pattern}`;
  }

  /**
   * Creates a condition that checks if a column does not match a specific pattern.
   */
  static notLike(column: string, pattern: string): Sql {
    return sql`${raw(column)} NOT LIKE ${pattern}`;
  }

  /**
   * Creates a condition that checks if a column is NULL.
   */
  static isNull(column: string): Sql {
    return sql`${raw(column)} IS NULL`;
  }

  /**
   * Creates a condition that checks if a column is NOT NULL.
   */
  static isNotNull(column: string): Sql {
    return sql`${raw(column)} IS NOT NULL`;
  }

  /**
   * Creates a condition that checks if a column is within a specific range.
   */
  static between(column: string, start: any, end: any): Sql {
    return sql`${raw(column)} BETWEEN ${start} AND ${end}`;
  }

  /**
   * Creates a condition that checks if a column is not within a specific range.
   */
  static notBetween(column: string, start: any, end: any): Sql {
    return sql`${raw(column)} NOT BETWEEN ${start} AND ${end}`;
  }

  /**
   * Creates a condition that checks if a column is greater than a specific value.
   */
  static gt(column: string | Sql, value: any): Sql {
    if (typeof column === "string") {
      return sql`${raw(column)} > ${value}`;
    }
    return sql`${column} > ${value}`;
  }

  /**
   * Creates a condition that checks if a column is greater than or equal to a specific value.
   */
  static gte(column: string, value: any): Sql {
    return sql`${raw(column)} >= ${value}`;
  }

  /**
   * Creates a condition that checks if a column is less than a specific value.
   */
  static lt(column: string | Sql, value: any): Sql {
    if (typeof column === "string") {
      return sql`${raw(column)} < ${value}`;
    }
    return sql`${column} < ${value}`;
  }

  /**
   * Creates a condition that checks if a column is less than or equal to a specific value.
   */
  static lte(column: string, value: any): Sql {
    return sql`${raw(column)} <= ${value}`;
  }

  /**
   * Combines multiple conditions with OR.
   */
  static or(conditions: Sql[]): Sql {
    return sql`(${join(conditions, " OR ")})`;
  }

  /**
   * Combines multiple conditions with AND.
   */
  static and(conditions: Sql[]): Sql {
    return sql`(${join(conditions, " AND ")})`;
  }

  /**
   * Creates an arbitrary raw condition expression.
   *
   * @warning SQL injection risk: never pass user input directly.
   * Use only with internal or trusted literals.
   * @deprecated Use `unsafeRaw()` instead — it makes the risk explicit.
   */
  static raw(condition: string): Sql {
    return Conditions.unsafeRaw(condition);
  }

  /**
   * Creates an arbitrary raw condition expression.
   *
   * @warning SQL injection risk: never pass user input directly.
   * Use only with internal or trusted literals.
   */
  static unsafeRaw(condition: string): Sql {
    return sql`${raw(condition)}`;
  }

  private static readonly ALLOWED_AGGREGATES = [
    "COUNT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
  ];

  /**
   * Creates an aggregate function expression.
   *
   * @throws {Error} Thrown when a disallowed aggregate function name is passed.
   */
  static aggregate(fn: string, column: string): Sql {
    const normalized = fn.trim().toUpperCase();
    if (!Conditions.ALLOWED_AGGREGATES.includes(normalized)) {
      throw new Error(
        `Unsupported aggregate function: "${fn}". Allowed: ${Conditions.ALLOWED_AGGREGATES.join(", ")}`,
      );
    }
    return sql`${raw(normalized)}(${raw(column)})`;
  }

  /**
   * Creates a COUNT aggregate function for a column.
   */
  static count(column: string): Sql {
    return this.aggregate("COUNT", column);
  }

  /**
   * Creates a SUM aggregate function for a column.
   */
  static sum(column: string): Sql {
    return this.aggregate("SUM", column);
  }

  /**
   * Creates an AVG aggregate function for a column.
   */
  static avg(column: string): Sql {
    return this.aggregate("AVG", column);
  }

  /**
   * Creates an IN (subquery) condition.
   */
  static inSubquery(column: string, subquery: Sql): Sql {
    return sql`${raw(column)} IN ${subquery}`;
  }

  /**
   * Creates a NOT IN (subquery) condition.
   */
  static notInSubquery(column: string, subquery: Sql): Sql {
    return sql`${raw(column)} NOT IN ${subquery}`;
  }

  /**
   * Creates an EXISTS condition.
   */
  static exists(subquery: Sql): Sql {
    // Check if EXISTS keyword is already included
    const subquerySql = subquery.sql;
    if (subquerySql.startsWith("EXISTS (")) {
      return subquery;
    }
    return sql`EXISTS ${subquery}`;
  }

  /**
   * Creates a NOT EXISTS condition.
   */
  static notExists(subquery: Sql): Sql {
    return sql`NOT EXISTS ${subquery}`;
  }

  private static readonly ALLOWED_OPERATORS = [
    "=",
    "!=",
    "<>",
    "<",
    ">",
    "<=",
    ">=",
    "LIKE",
    "IN",
    "NOT IN",
    "IS NULL",
    "IS NOT NULL",
  ];

  /**
   * Binary operators valid for column-to-column comparisons.
   * Excludes unary (IS NULL, IS NOT NULL) and set (IN, NOT IN) operators.
   */
  private static readonly BINARY_OPERATORS = [
    "=",
    "!=",
    "<>",
    "<",
    ">",
    "<=",
    ">=",
    "LIKE",
  ];

  /**
   * Operators valid for column-to-subquery comparisons.
   * Excludes unary operators (IS NULL, IS NOT NULL).
   */
  private static readonly SUBQUERY_OPERATORS = [
    "=",
    "!=",
    "<>",
    "<",
    ">",
    "<=",
    ">=",
    "IN",
    "NOT IN",
  ];

  private static validateOperator(operator: string): void {
    const normalized = operator.trim().toUpperCase();
    if (!Conditions.ALLOWED_OPERATORS.includes(normalized)) {
      throw new Error(
        `Invalid operator: "${operator}". Allowed operators: ${Conditions.ALLOWED_OPERATORS.join(", ")}`,
      );
    }
  }

  private static validateSubqueryOperator(operator: string): void {
    const normalized = operator.trim().toUpperCase();
    if (!Conditions.SUBQUERY_OPERATORS.includes(normalized)) {
      throw new Error(
        `Invalid operator for subquery comparison: "${operator}". Allowed operators: ${Conditions.SUBQUERY_OPERATORS.join(", ")}`,
      );
    }
  }

  private static validateBinaryOperator(operator: string): void {
    const normalized = operator.trim().toUpperCase();
    if (!Conditions.BINARY_OPERATORS.includes(normalized)) {
      throw new Error(
        `Invalid operator for column comparison: "${operator}". Allowed operators: ${Conditions.BINARY_OPERATORS.join(", ")}`,
      );
    }
  }

  /**
   * Combines a comparison operator with a subquery.
   */
  static compareSubquery(column: string, operator: string, subquery: Sql): Sql {
    Conditions.validateSubqueryOperator(operator);
    return sql`${raw(column)} ${raw(operator.trim().toUpperCase())} ${subquery}`;
  }

  /**
   * Creates a full-text search condition.
   *
   * - MySQL: `MATCH(c1, c2, ...) AGAINST(query IN <mode> MODE)`. `mode` is
   *   `boolean` (default) or `natural`.
   * - PostgreSQL (default): single column emits
   *   `to_tsvector('lang', col) @@ plainto_tsquery('lang', query)`; multi-column
   *   composes `COALESCE(c1, '') || ' ' || COALESCE(c2, '')` inside the tsvector.
   *
   * The fourth argument accepts either the legacy positional language string
   * or an options object with `{ language?, mode? }`.
   *
   * @param columns - One already-escaped column identifier or an array of them.
   * @param query - The search query string (parameterized).
   * @param dialect - "mysql" | "postgres" | "sqlite" (default: "postgres").
   * @param optionsOrLanguage - Options object or, for back-compat, a PG language string.
   */
  static fullTextSearch(
    columns: string | readonly string[],
    query: string,
    dialect?: string,
    optionsOrLanguage?: string | FullTextSearchOptions,
  ): Sql {
    const cols = Array.isArray(columns) ? columns : [columns as string];
    const opts: FullTextSearchOptions =
      typeof optionsOrLanguage === "string"
        ? { language: optionsOrLanguage }
        : (optionsOrLanguage ?? {});

    if (dialect === "mysql") {
      const modeKw = opts.mode === "natural" ? "NATURAL LANGUAGE" : "BOOLEAN";
      const colList = join(cols.map((c) => sql`${raw(c)}`), ", ");
      return sql`MATCH(${colList}) AGAINST(${query} IN ${raw(modeKw)} MODE)`;
    }
    // PostgreSQL default
    const lang = opts.language ?? "english";
    if (cols.length === 1) {
      return sql`to_tsvector(${lang}, ${raw(cols[0])}) @@ plainto_tsquery(${lang}, ${query})`;
    }
    const parts = cols.map((c) => sql`COALESCE(${raw(c)}, '')`);
    let concat: Sql = parts[0];
    for (let i = 1; i < parts.length; i++) {
      concat = sql`${concat} || ' ' || ${parts[i]}`;
    }
    return sql`to_tsvector(${lang}, ${concat}) @@ plainto_tsquery(${lang}, ${query})`;
  }

  /**
   * Creates a column-to-column comparison condition.
   */
  static compareColumns(
    column1: string,
    operator: string,
    column2: string,
  ): Sql {
    Conditions.validateBinaryOperator(operator);
    return sql`${raw(column1)} ${raw(operator.trim().toUpperCase())} ${raw(column2)}`;
  }
}
