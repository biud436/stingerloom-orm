import sql, { raw } from "sql-template-tag";
import type { Sql } from "sql-template-tag";
import type { ColumnJsonMeta, DialectExpression } from "../DialectExpression";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { buildJsonPathString } from "./MySqlExpression";

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

  jsonExtract(
    column: string,
    path: ReadonlyArray<string | number>,
    _asText: boolean,
    _meta?: ColumnJsonMeta,
  ): Sql {
    // SQLite's json_extract returns SQL-typed values (text for strings, integer
    // for numbers, etc.), so the asText distinction is not applicable.
    if (path.length === 0) {
      return sql`${raw(column)}`;
    }
    const p = buildJsonPathString(path);
    return sql`json_extract(${raw(column)}, ${p})`;
  }

  jsonContains(
    column: string,
    path: ReadonlyArray<string | number>,
    value: unknown,
    _meta?: ColumnJsonMeta,
  ): Sql {
    // SQLite has no native JSON containment operator. For scalars we fall back
    // to an equality check at the given path; for objects/arrays we refuse
    // rather than silently producing wrong results.
    if (value === null || typeof value === "object") {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_DATABASE,
        "jsonContains() with object/array values is not supported on SQLite. " +
          "Use scalar equality (e.g. metadata.profile.role.eq('admin')) or raw SQL.",
      );
    }
    const p = buildJsonPathString(path);
    return sql`json_extract(${raw(column)}, ${p}) = ${value as string | number | boolean}`;
  }

  jsonHasKey(
    column: string,
    path: ReadonlyArray<string | number>,
    key: string,
    _meta?: ColumnJsonMeta,
  ): Sql {
    const p = buildJsonPathString([...path, key]);
    return sql`json_extract(${raw(column)}, ${p}) IS NOT NULL`;
  }

  jsonArrayLength(
    column: string,
    path: ReadonlyArray<string | number>,
    _meta?: ColumnJsonMeta,
  ): Sql {
    if (path.length === 0) {
      return sql`json_array_length(${raw(column)})`;
    }
    const p = buildJsonPathString(path);
    return sql`json_array_length(${raw(column)}, ${p})`;
  }

  jsonTypeOf(
    column: string,
    path: ReadonlyArray<string | number>,
    _meta?: ColumnJsonMeta,
  ): Sql {
    if (path.length === 0) {
      return sql`json_type(${raw(column)})`;
    }
    const p = buildJsonPathString(path);
    return sql`json_type(${raw(column)}, ${p})`;
  }
}
