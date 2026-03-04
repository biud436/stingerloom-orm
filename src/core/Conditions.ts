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
   */
  static raw(condition: string): Sql {
    return sql`${raw(condition)}`;
  }

  /**
   * Creates an aggregate function expression.
   */
  static aggregate(fn: string, column: string): Sql {
    return sql`${raw(fn)}(${raw(column)})`;
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

  private static validateOperator(operator: string): void {
    const normalized = operator.trim().toUpperCase();
    if (!Conditions.ALLOWED_OPERATORS.includes(normalized)) {
      throw new Error(
        `Invalid operator: "${operator}". Allowed operators: ${Conditions.ALLOWED_OPERATORS.join(", ")}`,
      );
    }
  }

  /**
   * Combines a comparison operator with a subquery.
   */
  static compareSubquery(column: string, operator: string, subquery: Sql): Sql {
    Conditions.validateOperator(operator);
    return sql`${raw(column)} ${raw(operator.trim().toUpperCase())} ${subquery}`;
  }

  /**
   * Creates a column-to-column comparison condition.
   */
  static compareColumns(
    column1: string,
    operator: string,
    column2: string,
  ): Sql {
    Conditions.validateOperator(operator);
    return sql`${raw(column1)} ${raw(operator.trim().toUpperCase())} ${raw(column2)}`;
  }
}
