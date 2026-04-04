import sql, { raw } from "sql-template-tag";
import type { Sql } from "sql-template-tag";
import type { DialectExpression } from "../DialectExpression";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

export class SqliteExpression implements DialectExpression {
  readonly dialect = "sqlite" as const;

  /**
   * SQLite LIKE is case-insensitive for ASCII characters by default.
   *
   * Note: For Unicode characters, SQLite LIKE is case-sensitive.
   */
  ilike(column: string, value: string): Sql {
    return sql`${raw(column)} LIKE ${value}`;
  }

  fullTextSearch(_column: string, _query: string, _language?: string): Sql {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      "Full-text search via the query builder is not supported for SQLite. " +
        "Use SQLite FTS5 virtual tables with raw queries instead.",
    );
  }
}
