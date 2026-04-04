import sql, { raw } from "sql-template-tag";
import type { Sql } from "sql-template-tag";
import type { DialectExpression } from "../DialectExpression";

export class PostgresExpression implements DialectExpression {
  readonly dialect = "postgres" as const;

  ilike(column: string, value: string): Sql {
    return sql`${raw(column)} ILIKE ${value}`;
  }

  fullTextSearch(column: string, query: string, language?: string): Sql {
    const lang = language ?? "english";
    return sql`to_tsvector(${lang}, ${raw(column)}) @@ plainto_tsquery(${lang}, ${query})`;
  }
}
