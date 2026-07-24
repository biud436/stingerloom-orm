import { Sql } from "../utils/sqlTag";
import type { DatabaseType, RawQueryBuilder, RawQueryExecutor } from "./RawQueryBuilder";
import type { CompiledQuery } from "./CompiledQuery";

/**
 * Interface representing a base raw query builder.
 * Provides methods to construct SQL queries dynamically.
 */
export interface BaseRawQueryBuilder {
  /**
   * Sets the database type for the query.
   * @param type - The type of the database.
   * @returns The current instance of the query builder.
   */
  setDatabaseType(type: DatabaseType): BaseRawQueryBuilder;

  /**
   * Specifies the columns to select in the query.
   * @param columns - An array of column names or "*" to select all columns.
   * @returns The current instance of the query builder.
   */
  select(columns: string[] | "*"): BaseRawQueryBuilder;

  /**
   * Specifies the table to select from.
   * @param table - The name of the table.
   * @param alias - An optional alias for the table.
   * @returns The current instance of the query builder.
   */
  from(table: string | Sql, alias?: string): BaseRawQueryBuilder;

  /**
   * Adds conditions to the WHERE clause of the query.
   * @param conditions - An array of SQL conditions.
   * @returns The current instance of the query builder.
   */
  where(conditions: Sql[]): BaseRawQueryBuilder;

  /**
   * Adds an additional AND condition to the WHERE clause.
   * Must be called after where().
   */
  andWhere(condition: Sql): BaseRawQueryBuilder;

  /**
   * Adds an additional OR condition to the WHERE clause.
   * Must be called after where().
   */
  orWhere(condition: Sql): BaseRawQueryBuilder;

  /**
   * Adds a WHERE col IN (...) condition.
   */
  whereIn(column: string, values: any[]): BaseRawQueryBuilder;

  /**
   * Adds a WHERE col NOT IN (...) condition.
   */
  whereNotIn(column: string, values: any[]): BaseRawQueryBuilder;

  /**
   * Adds a WHERE col IS NULL condition.
   */
  whereNull(column: string): BaseRawQueryBuilder;

  /**
   * Adds a WHERE col IS NOT NULL condition.
   */
  whereNotNull(column: string): BaseRawQueryBuilder;

  /**
   * Adds a WHERE col BETWEEN min AND max condition.
   */
  whereBetween(column: string, min: any, max: any): BaseRawQueryBuilder;

  /**
   * Specifies the ORDER BY clause for the query.
   * @param orders - An array of objects specifying the column and direction (ASC or DESC) for ordering.
   * @returns The current instance of the query builder.
   */
  orderBy(
    orders: Array<{ column: string; direction: "ASC" | "DESC" }>,
  ): BaseRawQueryBuilder;

  /**
   * Specifies the LIMIT clause for the query.
   * @param limit - A number specifying the limit or an array specifying the offset and limit.
   * @returns The current instance of the query builder.
   */
  limit(limit: number | [number, number]): BaseRawQueryBuilder;

  /**
   * Adds a JOIN clause to the query.
   * @param type - The type of join (INNER, LEFT, or RIGHT).
   * @param table - The name of the table to join.
   * @param alias - The alias for the joined table.
   * @param condition - The condition for the join.
   * @returns The current instance of the query builder.
   */
  join(
    type: "INNER" | "LEFT" | "RIGHT",
    table: string | Sql,
    alias: string,
    condition: Sql,
  ): BaseRawQueryBuilder;

  /**
   * Adds a LEFT JOIN clause to the query.
   * Convenience method for join("LEFT", ...).
   */
  leftJoin(
    table: string | Sql,
    alias: string,
    condition: Sql,
  ): BaseRawQueryBuilder;

  /**
   * Adds an INNER JOIN clause to the query.
   * Convenience method for join("INNER", ...).
   */
  innerJoin(
    table: string | Sql,
    alias: string,
    condition: Sql,
  ): BaseRawQueryBuilder;

  /**
   * Adds a RIGHT JOIN clause to the query.
   * Convenience method for join("RIGHT", ...).
   */
  rightJoin(
    table: string | Sql,
    alias: string,
    condition: Sql,
  ): BaseRawQueryBuilder;

  /**
   * Specifies the OFFSET clause for the query.
   * @param offset - The number of rows to skip.
   * @returns The current instance of the query builder.
   */
  offset(offset: number): BaseRawQueryBuilder;

  /**
   * Specifies the GROUP BY clause for the query.
   * @param columns - Column names or parameterized {@link Sql} fragments
   *                  whose bindings must survive query assembly.
   */
  groupBy(columns: Array<string | Sql>): BaseRawQueryBuilder;

  /**
   * Adds conditions to the HAVING clause of the query.
   * @param conditions - An array of SQL conditions.
   * @returns The current instance of the query builder.
   */
  having(conditions: Sql[]): BaseRawQueryBuilder;

  /**
   * Appends a raw SQL fragment to the query.
   * @param sqlFragment - The SQL fragment to append.
   * @returns The current instance of the query builder.
   */
  appendSql(sqlFragment: Sql): BaseRawQueryBuilder;

  /**
   * Converts the query to a SQL object with an alias.
   * @param alias - The alias for the query.
   * @returns The SQL object representing the query with the alias.
   */
  as(alias: string): Sql;

  /**
   * Converts the query to a SQL object for use in an IN clause.
   * @returns The SQL object representing the query.
   */
  asInQuery(): Sql;

  /**
   * Converts the query to a SQL object for use in an EXISTS clause.
   * @returns The SQL object representing the query.
   */
  asExists(): Sql;

  /**
   * Adds a UNION clause.
   */
  union(): BaseRawQueryBuilder;

  /**
   * Adds a UNION ALL clause.
   */
  unionAll(): BaseRawQueryBuilder;

  /**
   * Adds an INTERSECT clause.
   */
  intersect(): BaseRawQueryBuilder;

  /**
   * Adds an EXCEPT clause.
   */
  except(): BaseRawQueryBuilder;

  /**
   * Adds a SELECT DISTINCT clause.
   */
  selectDistinct(columns: string[]): BaseRawQueryBuilder;

  /**
   * Adds a SELECT DISTINCT ON clause (PostgreSQL only).
   */
  selectDistinctOn(distinctColumns: string[], selectColumns: string[] | "*"): BaseRawQueryBuilder;

  /**
   * Adds a CTE (WITH clause).
   */
  with(name: string, subquery: Sql | ((qb: RawQueryBuilder) => RawQueryBuilder)): BaseRawQueryBuilder;

  /**
   * Adds a recursive CTE (WITH RECURSIVE clause).
   */
  withRecursive(name: string, subquery: Sql | ((qb: RawQueryBuilder) => RawQueryBuilder)): BaseRawQueryBuilder;

  /**
   * Adds a SELECT with window function expressions.
   */
  selectWithWindow(
    columns: Array<string | { expr: string; over: { partitionBy?: string; orderBy?: string }; alias: string }>,
  ): BaseRawQueryBuilder;

  /**
   * Builds the final SQL object representing the query.
   * @returns The SQL object representing the query.
   */
  build(): Sql;

  /**
   * Compile the query once; `.execute()` on the returned object skips
   * SQL assembly and only substitutes placeholder values.
   */
  prepare<
    T = Record<string, unknown>,
    P extends Record<string, unknown> = Record<string, unknown>,
  >(executor: RawQueryExecutor): CompiledQuery<T, P>;
}
