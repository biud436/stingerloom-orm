import sql, { raw, join } from "sql-template-tag";
import type { Sql } from "sql-template-tag";
import type { ColumnJsonMeta, DialectExpression } from "../DialectExpression";

export class PostgresExpression implements DialectExpression {
  readonly dialect = "postgres" as const;

  ilike(column: string, value: string): Sql {
    return sql`${raw(column)} ILIKE ${value}`;
  }

  fullTextSearch(column: string, query: string, language?: string): Sql {
    const lang = language ?? "english";
    return sql`to_tsvector(${lang}, ${raw(column)}) @@ plainto_tsquery(${lang}, ${query})`;
  }

  /** Build `ARRAY[$1, $2, ...]::text[]` from path segments. */
  private pathArray(path: ReadonlyArray<string | number>): Sql {
    const segs = path.map((s) => sql`${String(s)}`);
    return sql`ARRAY[${join(segs, ", ")}]::text[]`;
  }

  jsonExtract(
    column: string,
    path: ReadonlyArray<string | number>,
    asText: boolean,
    _meta?: ColumnJsonMeta,
  ): Sql {
    if (path.length === 0) {
      return sql`${raw(column)}`;
    }
    const op = asText ? "#>>" : "#>";
    return sql`${raw(column)} ${raw(op)} ${this.pathArray(path)}`;
  }

  jsonContains(
    column: string,
    path: ReadonlyArray<string | number>,
    value: unknown,
    _meta?: ColumnJsonMeta,
  ): Sql {
    const candidate = JSON.stringify(value);
    if (path.length === 0) {
      return sql`${raw(column)} @> ${candidate}::jsonb`;
    }
    return sql`(${raw(column)} #> ${this.pathArray(path)}) @> ${candidate}::jsonb`;
  }

  jsonHasKey(
    column: string,
    path: ReadonlyArray<string | number>,
    key: string,
    _meta?: ColumnJsonMeta,
  ): Sql {
    // Use `jsonb_exists()` rather than the `?` operator: the operator collides
    // with sql-template-tag's `?` parameter placeholder, which the Postgres
    // connector rewrites to `$N` unconditionally.
    if (path.length === 0) {
      return sql`jsonb_exists(${raw(column)}, ${key})`;
    }
    return sql`jsonb_exists(${raw(column)} #> ${this.pathArray(path)}, ${key})`;
  }

  jsonArrayLength(
    column: string,
    path: ReadonlyArray<string | number>,
    _meta?: ColumnJsonMeta,
  ): Sql {
    if (path.length === 0) {
      return sql`jsonb_array_length(${raw(column)})`;
    }
    return sql`jsonb_array_length(${raw(column)} #> ${this.pathArray(path)})`;
  }

  jsonTypeOf(
    column: string,
    path: ReadonlyArray<string | number>,
    _meta?: ColumnJsonMeta,
  ): Sql {
    if (path.length === 0) {
      return sql`jsonb_typeof(${raw(column)})`;
    }
    return sql`jsonb_typeof(${raw(column)} #> ${this.pathArray(path)})`;
  }
}
