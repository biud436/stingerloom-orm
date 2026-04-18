import sql, { raw } from "sql-template-tag";
import type { Sql } from "sql-template-tag";
import type {
  CastKind,
  ColumnJsonMeta,
  DialectExpression,
} from "../DialectExpression";

/**
 * Serialize a JSON path into MySQL/SQLite syntax: `$.a.b[0].c`.
 *
 * - Identifier-like string segments are emitted bare (`a`, `b_2`, `$var`).
 * - Non-identifier strings are double-quoted with embedded quotes escaped.
 * - Numeric segments become `[n]` array indices.
 */
export function buildJsonPathString(path: ReadonlyArray<string | number>): string {
  let out = "$";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(seg)) {
      out += `.${seg}`;
    } else {
      out += `."${seg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
  }
  return out;
}

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

  /**
   * Guaranteed case-insensitive LIKE regardless of collation.
   *
   * `utf8mb4_bin` columns do not fold case, so relying on default `LIKE`
   * semantics would miss matches. Wrapping both sides in `LOWER()` makes
   * the comparison collation-independent.
   */
  caseInsensitiveLike(column: string, pattern: string): Sql {
    return sql`LOWER(${raw(column)}) LIKE LOWER(${pattern}) ESCAPE ${"\\"}`;
  }

  fullTextSearch(column: string, query: string, _language?: string): Sql {
    return sql`MATCH(${raw(column)}) AGAINST(${query} IN BOOLEAN MODE)`;
  }

  jsonExtract(
    column: string,
    path: ReadonlyArray<string | number>,
    asText: boolean,
    _meta?: ColumnJsonMeta,
  ): Sql {
    const p = buildJsonPathString(path);
    if (asText) {
      return sql`JSON_UNQUOTE(JSON_EXTRACT(${raw(column)}, ${p}))`;
    }
    return sql`JSON_EXTRACT(${raw(column)}, ${p})`;
  }

  jsonContains(
    column: string,
    path: ReadonlyArray<string | number>,
    value: unknown,
    _meta?: ColumnJsonMeta,
  ): Sql {
    const candidate = JSON.stringify(value);
    const p = buildJsonPathString(path);
    return sql`JSON_CONTAINS(${raw(column)}, ${candidate}, ${p})`;
  }

  jsonHasKey(
    column: string,
    path: ReadonlyArray<string | number>,
    key: string,
    _meta?: ColumnJsonMeta,
  ): Sql {
    const p = buildJsonPathString([...path, key]);
    return sql`JSON_CONTAINS_PATH(${raw(column)}, 'one', ${p})`;
  }

  jsonArrayLength(
    column: string,
    path: ReadonlyArray<string | number>,
    _meta?: ColumnJsonMeta,
  ): Sql {
    if (path.length === 0) {
      return sql`JSON_LENGTH(${raw(column)})`;
    }
    const p = buildJsonPathString(path);
    return sql`JSON_LENGTH(${raw(column)}, ${p})`;
  }

  jsonTypeOf(
    column: string,
    path: ReadonlyArray<string | number>,
    _meta?: ColumnJsonMeta,
  ): Sql {
    if (path.length === 0) {
      return sql`JSON_TYPE(${raw(column)})`;
    }
    const p = buildJsonPathString(path);
    return sql`JSON_TYPE(JSON_EXTRACT(${raw(column)}, ${p}))`;
  }

  castTypeName(kind: CastKind): string {
    switch (kind) {
      case "string":
        return "CHAR";
      case "int":
      case "long":
        return "SIGNED";
      case "float":
        return "DECIMAL";
      case "boolean":
        return "UNSIGNED";
    }
  }
}
