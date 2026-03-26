/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, join, raw } from "sql-template-tag";

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
   */
  static in(column: string, values: any[]): Sql {
    return sql`${raw(column)} IN (${join(
      values.map((v) => sql`${v}`),
      ", ",
    )})`;
  }

  /**
   * Creates a condition that checks if a column does not match any of the specified values.
   */
  static notIn(column: string, values: any[]): Sql {
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
   * @warning SQL Injection 위험: 사용자 입력을 직접 전달하지 마세요.
   * 이 메서드는 내부 또는 신뢰된 리터럴에만 사용해야 합니다.
   * @deprecated `unsafeRaw()`를 대신 사용하세요 — 위험성을 명시적으로 나타냅니다.
   */
  static raw(condition: string): Sql {
    return Conditions.unsafeRaw(condition);
  }

  /**
   * Creates an arbitrary raw condition expression.
   *
   * @warning SQL Injection 위험: 사용자 입력을 직접 전달하지 마세요.
   * 이 메서드는 내부 또는 신뢰된 리터럴에만 사용해야 합니다.
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
   * @throws {Error} 허용되지 않은 집계 함수명이 전달되면 에러를 발생시킵니다.
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
   * - MySQL: `MATCH(column) AGAINST(query IN BOOLEAN MODE)`
   * - PostgreSQL (default): `to_tsvector('lang', column) @@ plainto_tsquery('lang', query)`
   *
   * @param column - Already-escaped column identifier.
   * @param query - The search query string (parameterized).
   * @param dialect - "mysql" | "postgres" | "sqlite" (default: "postgres").
   * @param language - PostgreSQL text search config (default: "english").
   */
  static fullTextSearch(
    column: string,
    query: string,
    dialect?: string,
    language?: string,
  ): Sql {
    if (dialect === "mysql") {
      return sql`MATCH(${raw(column)}) AGAINST(${query} IN BOOLEAN MODE)`;
    }
    // PostgreSQL default
    const lang = language ?? "english";
    return sql`to_tsvector(${lang}, ${raw(column)}) @@ plainto_tsquery(${lang}, ${query})`;
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
