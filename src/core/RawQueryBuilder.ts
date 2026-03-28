import sql, { Sql, raw, join } from "sql-template-tag";
import { BaseRawQueryBuilder } from "./BaseRawQueryBuilder";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

export type DatabaseType = "mysql" | "postgresql" | "sqlite";
export type SubqueryType = "SELECT" | "FROM" | "WHERE" | "HAVING";

/**
 * @class RawQueryBuilder
 *
 * RawQueryBuilder에는 별칭 지정 기능과 Type Safe하게 자동 완성을 지원하는 기능이 없습니다.
 * 따라서 직접적으로 사용하기보단 타입이 지원되는 래퍼 클래스를 통해 사용하는 것이 좋습니다.
 */
export class RawQueryBuilder implements BaseRawQueryBuilder {
  private sqlQuerySegments: Sql[] = [];
  private dbType: DatabaseType = "mysql"; // 기본값
  private isSubquery: boolean = false;
  private hasWhereClause: boolean = false;
  private cteClauses: Array<{ name: string; sql: Sql; recursive: boolean }> = [];

  private escapeIdent(name: string): string {
    if (this.dbType === "mysql") {
      return `\`${name.replace(/`/g, "``")}\``;
    }
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Create a new instance of the RawQueryBuilder.
   */
  static create(): RawQueryBuilder {
    return new RawQueryBuilder();
  }

  /**
   * Creates a subquery instance of the RawQueryBuilder.
   */
  static subquery(): RawQueryBuilder {
    const builder = new RawQueryBuilder();
    builder.isSubquery = true;
    return builder;
  }

  /**
   * Sets the database type for the query.
   * @param type - The type of the database.
   * @returns The current instance of the query builder.
   */
  setDatabaseType(type: DatabaseType): RawQueryBuilder {
    this.dbType = type;
    return this;
  }

  /**
   * Specifies the columns to select in the query.
   * @param columns - An array of column names or "*" to select all columns.
   * @returns The current instance of the query builder.
   */
  select(columns: string[] | "*"): RawQueryBuilder {
    if (columns === "*") {
      this.sqlQuerySegments.push(sql`SELECT *`);
    } else {
      if (columns.length === 0) {
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          "select() requires at least one column. Use \"*\" to select all columns.",
        );
      }
      const columnSqls = columns.map((col) => sql`${raw(col)}`);
      this.sqlQuerySegments.push(sql`SELECT ${join(columnSqls, ", ")}`);
    }
    return this;
  }

  /**
   * Specifies the table to select from.
   * @param table - The name of the table.
   * @param alias - An optional alias for the table.
   * @returns The current instance of the query builder.
   */
  from(table: string | Sql, alias?: string): RawQueryBuilder {
    if (alias) {
      if (typeof table === "string") {
        this.sqlQuerySegments.push(sql`FROM ${raw(table)} AS ${raw(alias)}`);
      } else {
        // 서브쿼리의 경우 이미 AS가 포함되어 있으므로 별칭만 추가
        this.sqlQuerySegments.push(sql`FROM ${table} ${raw(alias)}`);
      }
    } else {
      this.sqlQuerySegments.push(
        sql`FROM ${typeof table === "string" ? raw(table) : table}`,
      );
    }
    return this;
  }

  /**
   * Adds conditions to the WHERE clause of the query.
   * @param conditions - An array of SQL conditions.
   * @returns The current instance of the query builder.
   */
  where(conditions: Sql[]): RawQueryBuilder {
    if (conditions.length === 0) {
      // No conditions: skip WHERE clause entirely (matches all rows)
      this.hasWhereClause = true;
      return this;
    }
    this.sqlQuerySegments.push(sql`WHERE ${join(conditions, " AND ")}`);
    this.hasWhereClause = true;
    return this;
  }

  /**
   * Adds an additional AND condition to the WHERE clause.
   * Must be called after where().
   * @param condition - The SQL condition to AND.
   * @returns The current instance of the query builder.
   */
  andWhere(condition: Sql): RawQueryBuilder {
    this.sqlQuerySegments.push(sql`AND ${condition}`);
    return this;
  }

  /**
   * Adds an additional OR condition to the WHERE clause.
   * Must be called after where().
   * @param condition - The SQL condition to OR.
   * @returns The current instance of the query builder.
   */
  orWhere(condition: Sql): RawQueryBuilder {
    this.sqlQuerySegments.push(sql`OR ${condition}`);
    return this;
  }

  /**
   * Adds a WHERE col IN (...) condition.
   * Can be used standalone (adds WHERE) or after where() (adds AND).
   * @param column - The column name (already escaped).
   * @param values - The values for the IN clause.
   * @returns The current instance of the query builder.
   */
  whereIn(column: string, values: any[]): RawQueryBuilder {
    const keyword = this.hasWhereClause ? "AND" : "WHERE";
    if (values.length === 0) {
      // Empty IN set can never match — emit FALSE
      this.sqlQuerySegments.push(sql`${raw(keyword)} 1=0`);
      this.hasWhereClause = true;
      return this;
    }
    const valueSqls = values.map((v) => sql`${v}`);
    this.sqlQuerySegments.push(
      sql`${raw(keyword)} ${raw(column)} IN (${join(valueSqls, ", ")})`,
    );
    this.hasWhereClause = true;
    return this;
  }

  /**
   * Adds a WHERE col NOT IN (...) condition.
   * @param column - The column name (already escaped).
   * @param values - The values for the NOT IN clause.
   * @returns The current instance of the query builder.
   */
  whereNotIn(column: string, values: any[]): RawQueryBuilder {
    if (values.length === 0) {
      // Empty NOT IN set matches everything — no condition needed
      return this;
    }
    const valueSqls = values.map((v) => sql`${v}`);
    const keyword = this.hasWhereClause ? "AND" : "WHERE";
    this.sqlQuerySegments.push(
      sql`${raw(keyword)} ${raw(column)} NOT IN (${join(valueSqls, ", ")})`,
    );
    this.hasWhereClause = true;
    return this;
  }

  /**
   * Adds a WHERE col IS NULL condition.
   * @param column - The column name (already escaped).
   * @returns The current instance of the query builder.
   */
  whereNull(column: string): RawQueryBuilder {
    const keyword = this.hasWhereClause ? "AND" : "WHERE";
    this.sqlQuerySegments.push(sql`${raw(keyword)} ${raw(column)} IS NULL`);
    this.hasWhereClause = true;
    return this;
  }

  /**
   * Adds a WHERE col IS NOT NULL condition.
   * @param column - The column name (already escaped).
   * @returns The current instance of the query builder.
   */
  whereNotNull(column: string): RawQueryBuilder {
    const keyword = this.hasWhereClause ? "AND" : "WHERE";
    this.sqlQuerySegments.push(sql`${raw(keyword)} ${raw(column)} IS NOT NULL`);
    this.hasWhereClause = true;
    return this;
  }

  /**
   * Adds a WHERE col BETWEEN min AND max condition.
   * @param column - The column name (already escaped).
   * @param min - The minimum value.
   * @param max - The maximum value.
   * @returns The current instance of the query builder.
   */
  whereBetween(column: string, min: any, max: any): RawQueryBuilder {
    const keyword = this.hasWhereClause ? "AND" : "WHERE";
    this.sqlQuerySegments.push(
      sql`${raw(keyword)} ${raw(column)} BETWEEN ${min} AND ${max}`,
    );
    this.hasWhereClause = true;
    return this;
  }

  /**
   * Specifies the ORDER BY clause for the query.
   * @param orders - An array of objects specifying the column and direction (ASC or DESC) for ordering.
   * @returns The current instance of the query builder.
   */
  orderBy(
    orders: Array<{ column: string; direction: "ASC" | "DESC" }>,
  ): RawQueryBuilder {
    if (orders.length === 0) return this;

    const orderSqls = orders.map(
      ({ column, direction }) => {
        const safeDirection = direction.toUpperCase();
        if (safeDirection !== "ASC" && safeDirection !== "DESC") {
          throw new OrmError(OrmErrorCode.QUERY_ERROR, `Invalid ORDER BY direction: ${direction}`);
        }
        return sql`${raw(column)} ${raw(safeDirection)}`;
      },
    );
    this.sqlQuerySegments.push(sql`ORDER BY ${join(orderSqls, ", ")}`);
    return this;
  }

  /**
   * Specifies the LIMIT clause for the query.
   * @param limit - A number specifying the limit or an array specifying the offset and limit.
   * @returns The current instance of the query builder.
   */
  limit(limit: number | [number, number]): RawQueryBuilder {
    if (Array.isArray(limit)) {
      const [offset, count] = limit;
      if (this.dbType === "mysql") {
        this.sqlQuerySegments.push(sql`LIMIT ${offset}, ${count}`);
      } else if (this.dbType === "postgresql") {
        this.sqlQuerySegments.push(sql`LIMIT ${count} OFFSET ${offset}`);
      } else {
        // Default to PostgreSQL syntax for other databases
        this.sqlQuerySegments.push(sql`LIMIT ${count} OFFSET ${offset}`);
      }
    } else {
      this.sqlQuerySegments.push(sql`LIMIT ${limit}`);
    }
    return this;
  }

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
  ): RawQueryBuilder {
    if (typeof table === "string") {
      if (table.includes(` AS ${alias}`)) {
        this.sqlQuerySegments.push(
          sql`${raw(type)} JOIN ${raw(table)} ON ${condition}`,
        );
      } else {
        this.sqlQuerySegments.push(
          sql`${raw(type)} JOIN ${raw(table)} AS ${raw(alias)} ON ${condition}`,
        );
      }
    } else {
      // 서브쿼리의 경우, AS가 이미 포함되어 있는지 확인
      const tableStr = table.sql;
      if (tableStr.includes(` AS ${alias}`)) {
        this.sqlQuerySegments.push(
          sql`${raw(type)} JOIN ${table} ON ${condition}`,
        );
      } else {
        this.sqlQuerySegments.push(
          sql`${raw(type)} JOIN ${table} AS ${raw(alias)} ON ${condition}`,
        );
      }
    }
    return this;
  }

  /**
   * Specifies the GROUP BY clause for the query.
   * @param columns - An array of column names to group by.
   * @returns The current instance of the query builder.
   */
  groupBy(columns: string[]): RawQueryBuilder {
    if (columns.length === 0) return this;
    const columnSqls = columns.map((col) => sql`${raw(col)}`);
    this.sqlQuerySegments.push(sql`GROUP BY ${join(columnSqls, ", ")}`);
    return this;
  }

  /**
   * Adds conditions to the HAVING clause of the query.
   * @param conditions - An array of SQL conditions.
   * @returns The current instance of the query builder.
   */
  having(conditions: Sql[]): RawQueryBuilder {
    if (conditions.length === 0) return this;
    this.sqlQuerySegments.push(sql`HAVING ${join(conditions, " AND ")}`);
    return this;
  }

  /**
   * Adds a LEFT JOIN clause to the query.
   * Convenience method for join("LEFT", ...).
   */
  leftJoin(
    table: string | Sql,
    alias: string,
    condition: Sql,
  ): RawQueryBuilder {
    return this.join("LEFT", table, alias, condition);
  }

  /**
   * Adds an INNER JOIN clause to the query.
   * Convenience method for join("INNER", ...).
   */
  innerJoin(
    table: string | Sql,
    alias: string,
    condition: Sql,
  ): RawQueryBuilder {
    return this.join("INNER", table, alias, condition);
  }

  /**
   * Adds a RIGHT JOIN clause to the query.
   * Convenience method for join("RIGHT", ...).
   */
  rightJoin(
    table: string | Sql,
    alias: string,
    condition: Sql,
  ): RawQueryBuilder {
    return this.join("RIGHT", table, alias, condition);
  }

  /**
   * Specifies the OFFSET clause for the query.
   * Can be used independently or alongside limit().
   * @param offset - The number of rows to skip.
   * @returns The current instance of the query builder.
   */
  offset(offset: number): RawQueryBuilder {
    this.sqlQuerySegments.push(sql`OFFSET ${offset}`);
    return this;
  }

  /**
   * Appends a raw SQL fragment to the query.
   * @param sqlFragment - The SQL fragment to append.
   * @returns The current instance of the query builder.
   */
  appendSql(sqlFragment: Sql): RawQueryBuilder {
    this.sqlQuerySegments.push(sqlFragment);
    return this;
  }

  /**
   * Converts the query to a SQL object with an alias.
   * @param alias - The alias for the query.
   * @returns The SQL object representing the query with the alias.
   */
  as(alias: string): Sql {
    const query = this.build();
    return sql`(${query}) AS ${raw(alias)}`;
  }

  /**
   * Converts the query to a SQL object for use in an IN clause.
   * @returns The SQL object representing the query.
   */
  asInQuery(): Sql {
    const query = this.build();
    return sql`(${query})`;
  }

  /**
   * Converts the query to a SQL object for use in an EXISTS clause.
   * @returns The SQL object representing the query.
   */
  asExists(): Sql {
    const query = this.build();
    return sql`EXISTS (${query})`;
  }

  /**
   * Adds a UNION clause to combine result sets (removes duplicates).
   */
  union(): RawQueryBuilder {
    this.sqlQuerySegments.push(sql`UNION`);
    return this;
  }

  /**
   * Adds a UNION ALL clause to combine result sets (keeps duplicates).
   */
  unionAll(): RawQueryBuilder {
    this.sqlQuerySegments.push(sql`UNION ALL`);
    return this;
  }

  /**
   * Adds an INTERSECT clause to return only rows common to both result sets.
   */
  intersect(): RawQueryBuilder {
    this.sqlQuerySegments.push(sql`INTERSECT`);
    return this;
  }

  /**
   * Adds an EXCEPT clause to return rows in the first result set but not in the second.
   */
  except(): RawQueryBuilder {
    this.sqlQuerySegments.push(sql`EXCEPT`);
    return this;
  }

  /**
   * Adds a SELECT DISTINCT clause.
   */
  selectDistinct(columns: string[]): RawQueryBuilder {
    if (columns.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "selectDistinct() requires at least one column.",
      );
    }
    const columnSqls = columns.map((col) => sql`${raw(col)}`);
    this.sqlQuerySegments.push(sql`SELECT DISTINCT ${join(columnSqls, ", ")}`);
    return this;
  }

  /**
   * Adds a SELECT DISTINCT ON clause (PostgreSQL only).
   */
  selectDistinctOn(distinctColumns: string[], selectColumns: string[] | "*"): RawQueryBuilder {
    if (this.dbType !== "postgresql") {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_OPERATION,
        `selectDistinctOn() is only supported on PostgreSQL. Current dialect: ${this.dbType}`,
      );
    }
    if (distinctColumns.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "selectDistinctOn() requires at least one DISTINCT ON column.",
      );
    }
    const distinctSqls = distinctColumns.map((col) => sql`${raw(col)}`);
    if (selectColumns === "*") {
      this.sqlQuerySegments.push(
        sql`SELECT DISTINCT ON (${join(distinctSqls, ", ")}) *`,
      );
    } else {
      if (selectColumns.length === 0) {
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          "selectDistinctOn() requires at least one select column. Use \"*\" to select all.",
        );
      }
      const selectSqls = selectColumns.map((col) => sql`${raw(col)}`);
      this.sqlQuerySegments.push(
        sql`SELECT DISTINCT ON (${join(distinctSqls, ", ")}) ${join(selectSqls, ", ")}`,
      );
    }
    return this;
  }

  /**
   * Adds a CTE (Common Table Expression / WITH clause).
   * Multiple calls are collected and rendered as a single WITH clause.
   * @param name - CTE name
   * @param subquery - A built Sql object or a callback that receives a new RawQueryBuilder
   */
  with(name: string, subquery: Sql | ((qb: RawQueryBuilder) => RawQueryBuilder)): RawQueryBuilder {
    let subSql: Sql;
    if (typeof subquery === "function") {
      // #180: Use factory subquery() if available, otherwise fallback to new instance
      // #175: inherit parent dialect
      const sub = this.createSubBuilder();
      subSql = subquery(sub).build();
    } else {
      subSql = subquery;
    }
    this.cteClauses.push({ name, sql: subSql, recursive: false });
    return this;
  }

  /**
   * Adds a recursive CTE (WITH RECURSIVE clause).
   * Multiple calls are collected and rendered as a single WITH RECURSIVE clause.
   * @param name - CTE name
   * @param subquery - A built Sql object or a callback that receives a new RawQueryBuilder
   */
  withRecursive(name: string, subquery: Sql | ((qb: RawQueryBuilder) => RawQueryBuilder)): RawQueryBuilder {
    let subSql: Sql;
    if (typeof subquery === "function") {
      const sub = this.createSubBuilder();
      subSql = subquery(sub).build();
    } else {
      subSql = subquery;
    }
    this.cteClauses.push({ name, sql: subSql, recursive: true });
    return this;
  }

  /**
   * Creates a sub-builder for CTE callbacks.
   * Uses RawQueryBuilderFactory.subquery() if available, inherits parent dbType.
   */
  private createSubBuilder(): RawQueryBuilder {
    let sub: RawQueryBuilder;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RawQueryBuilderFactory } = require("./RawQueryBuilderFactory");
      sub = RawQueryBuilderFactory.subquery() as RawQueryBuilder;
    } catch {
      sub = new RawQueryBuilder();
    }
    if (sub.setDatabaseType) {
      sub.setDatabaseType(this.dbType);
    }
    return sub;
  }

  /**
   * Adds a window function expression.
   * @param expr - Window function expression (e.g. "ROW_NUMBER()")
   * @param over - Window specification
   */
  selectWithWindow(
    columns: Array<string | { expr: string; over: { partitionBy?: string; orderBy?: string }; alias: string }>,
  ): RawQueryBuilder {
    const escapeColumnList = (input: string): string =>
      input
        .split(",")
        .map((part) => {
          const trimmed = part.trim();
          const tokens = trimmed.split(/\s+/);
          // Handle "col DESC" / "col ASC" pattern
          if (tokens.length === 2 && /^(ASC|DESC)$/i.test(tokens[1])) {
            return `${this.escapeIdent(tokens[0])} ${tokens[1]}`;
          }
          return this.escapeIdent(trimmed);
        })
        .join(", ");

    const ALLOWED_EXPR = /^[A-Z_]+\([a-zA-Z0-9_.*,\s]*\)$/;

    const parts: Sql[] = [];
    for (const col of columns) {
      if (typeof col === "string") {
        parts.push(sql`${raw(this.escapeIdent(col))}`);
      } else {
        if (!ALLOWED_EXPR.test(col.expr)) {
          throw new OrmError(
            OrmErrorCode.INVALID_QUERY,
            `selectWithWindow: invalid expression "${col.expr}". Only simple function calls like "ROW_NUMBER()" are allowed.`,
          );
        }
        const overParts: string[] = [];
        if (col.over.partitionBy) overParts.push(`PARTITION BY ${escapeColumnList(col.over.partitionBy)}`);
        if (col.over.orderBy) overParts.push(`ORDER BY ${escapeColumnList(col.over.orderBy)}`);
        const safeAlias = this.escapeIdent(col.alias);
        parts.push(sql`${raw(col.expr)} OVER (${raw(overParts.join(" "))}) AS ${raw(safeAlias)}`);
      }
    }
    this.sqlQuerySegments.push(sql`SELECT ${join(parts, ", ")}`);
    return this;
  }

  /**
   * Builds the final SQL object representing the query.
   * @returns The SQL object representing the query.
   */
  build(): Sql {
    const segments: Sql[] = [];

    // #174: Render all CTEs as a single WITH clause
    if (this.cteClauses.length > 0) {
      const hasRecursive = this.cteClauses.some((c) => c.recursive);
      const keyword = hasRecursive ? "WITH RECURSIVE" : "WITH";
      const cteParts = this.cteClauses.map(
        (c) => sql`${raw(c.name)} AS (${c.sql})`,
      );
      segments.push(sql`${raw(keyword)} ${join(cteParts, ", ")}`);
    }

    segments.push(...this.sqlQuerySegments);
    return join(segments, " ");
  }
}
