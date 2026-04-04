import sql, { raw } from "sql-template-tag";
import type { Sql } from "sql-template-tag";
import type { DialectExpression } from "../DialectExpression";

export class MySqlExpression implements DialectExpression {
  readonly dialect = "mysql" as const;

  /**
   * MySQL LIKE is case-insensitive by default with `utf8mb4_general_ci` collation.
   *
   * Note: For `utf8mb4_bin` collation, users should use explicit
   * `LOWER(column) LIKE LOWER(value)` via raw SQL instead.
   */
  ilike(column: string, value: string): Sql {
    return sql`${raw(column)} LIKE ${value}`;
  }

  fullTextSearch(column: string, query: string, _language?: string): Sql {
    return sql`MATCH(${raw(column)}) AGAINST(${query} IN BOOLEAN MODE)`;
  }
}
