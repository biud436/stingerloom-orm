import type { Sql } from "sql-template-tag";
import type { DialectName } from "../core/ColumnTypeRegistry";
import { PostgresExpression } from "./expression/PostgresExpression";
import { MySqlExpression } from "./expression/MySqlExpression";
import { SqliteExpression } from "./expression/SqliteExpression";

/**
 * Metadata about a JSON/JSONB column, threaded through JSON-path expression
 * resolution so dialect implementations can branch on storage type.
 *
 * Needed because PostgreSQL distinguishes `json` (text-backed, no native
 * containment operator) from `jsonb` (binary-encoded, supports `@>`, `?`,
 * `jsonb_path_ops` GIN). MySQL/SQLite expose only a single JSON type each
 * and generally ignore this hint.
 */
export interface ColumnJsonMeta {
  /** Underlying storage type as declared by `@Column({ type })`. */
  dbType: "json" | "jsonb";
  /** Whether the column itself is nullable. */
  nullable: boolean;
}

/**
 * Strategy interface for dialect-specific SQL expression generation.
 *
 * Each method takes already-qualified column identifiers (e.g. `"u"."name"`)
 * and user-supplied values, returning a parameterized `Sql` object.
 *
 * Implementations live in `src/dialects/expression/`.
 */
export interface DialectExpression {
  /** The dialect this expression generator targets. */
  readonly dialect: DialectName;

  /**
   * Case-insensitive LIKE.
   *
   * - PostgreSQL: native `ILIKE`
   * - MySQL: `LIKE` (case-insensitive by default with utf8mb4_general_ci)
   * - SQLite: `LIKE` (case-insensitive for ASCII)
   */
  ilike(column: string, value: string): Sql;

  /**
   * Case-insensitive LIKE with an explicit ESCAPE clause and collation-
   * independent semantics.
   *
   * Unlike {@link ilike}, this method guarantees case-insensitive behavior
   * on every dialect regardless of the column's collation:
   *
   * - PostgreSQL: `col ILIKE pattern ESCAPE '\'`
   * - MySQL:      `LOWER(col) LIKE LOWER(pattern) ESCAPE '\'`
   * - SQLite:     `LOWER(col) LIKE LOWER(pattern) ESCAPE '\'`
   *
   * Caller is responsible for escaping `%` / `_` / `\` in the user portion
   * of the pattern (see `escapeLikeValue` in core/expressions).
   *
   * @param column - Already-escaped column identifier (e.g. `"u"."name"`).
   * @param pattern - LIKE pattern. Metacharacters in user input should be
   *                  pre-escaped; the wildcards added by callers (e.g.
   *                  leading/trailing `%` for `contains`) are left intact.
   */
  caseInsensitiveLike(column: string, pattern: string): Sql;

  /**
   * Full-text search condition.
   *
   * - PostgreSQL: `to_tsvector('lang', column) @@ plainto_tsquery('lang', query)`
   * - MySQL: `MATCH(column) AGAINST(query IN BOOLEAN MODE)`
   * - SQLite: throws (unsupported)
   *
   * @param language - Text search config (PostgreSQL only, default: "english").
   */
  fullTextSearch(column: string, query: string, language?: string): Sql;

  /**
   * Extract a value at a JSON path inside a `json`/`jsonb` column.
   *
   * @param column - Already-escaped column identifier (e.g. `"u"."metadata"`).
   * @param path - Path segments (strings navigate objects, numbers navigate arrays).
   * @param asText - When true, coerce the extracted value to text (`->>` / `JSON_UNQUOTE`);
   *                when false, return raw JSON (`->` / `JSON_EXTRACT`).
   * @param meta - Optional column metadata. Used by dialects that branch on `json` vs `jsonb`.
   */
  jsonExtract(
    column: string,
    path: ReadonlyArray<string | number>,
    asText: boolean,
    meta?: ColumnJsonMeta,
  ): Sql;

  /**
   * JSON containment check: does the sub-document at `path` contain `value`?
   *
   * - PostgreSQL: `(column #> path) @> value::jsonb`
   * - MySQL: `JSON_CONTAINS(column, JSON candidate, '$.path')`
   * - SQLite: falls back to equality for scalars; throws for objects.
   */
  jsonContains(
    column: string,
    path: ReadonlyArray<string | number>,
    value: unknown,
    meta?: ColumnJsonMeta,
  ): Sql;

  /**
   * Key existence check on a JSON object located at `path`.
   *
   * - PostgreSQL: `(column #> path) ? key`
   * - MySQL: `JSON_CONTAINS_PATH(column, 'one', '$.path.key')`
   * - SQLite: `json_extract(column, '$.path.key') IS NOT NULL`
   */
  jsonHasKey(
    column: string,
    path: ReadonlyArray<string | number>,
    key: string,
    meta?: ColumnJsonMeta,
  ): Sql;

  /** Array length at the given JSON path. Returns an integer scalar expression. */
  jsonArrayLength(
    column: string,
    path: ReadonlyArray<string | number>,
    meta?: ColumnJsonMeta,
  ): Sql;

  /** JSON type at the given path. Returns a text scalar expression (`'object'`, `'array'`, etc.). */
  jsonTypeOf(
    column: string,
    path: ReadonlyArray<string | number>,
    meta?: ColumnJsonMeta,
  ): Sql;

  /**
   * Dialect-specific SQL type name for a given {@link CastKind}. Used
   * by scalar `.stringValue()` / `.intValue()` / etc. helpers to render
   * `CAST(x AS <name>)` with the right portable type label.
   *
   * Mapping:
   *
   * | Kind      | MySQL      | PostgreSQL | SQLite  |
   * |-----------|------------|------------|---------|
   * | `string`  | `CHAR`     | `TEXT`     | `TEXT`  |
   * | `int`     | `SIGNED`   | `INTEGER`  | `INTEGER` |
   * | `long`    | `SIGNED`   | `BIGINT`   | `INTEGER` |
   * | `float`   | `DECIMAL`  | `REAL`     | `REAL`  |
   * | `boolean` | `UNSIGNED` | `BOOLEAN`  | `INTEGER` |
   */
  castTypeName(kind: CastKind): string;
}

/**
 * Supported CAST target kinds for the `.stringValue()` /
 * `.intValue()` family. Resolved to a dialect-specific SQL type name
 * by {@link DialectExpression.castTypeName}.
 */
export type CastKind = "string" | "int" | "long" | "float" | "boolean";

/** Singleton cache — implementations are stateless. */
const cache = new Map<DialectName, DialectExpression>();

/**
 * Creates or retrieves a cached {@link DialectExpression} for the given dialect.
 *
 * Follows the same factory pattern as `createColumnDefinitionBuilder()`.
 */
export function createDialectExpression(dialect: DialectName): DialectExpression {
  let expr = cache.get(dialect);
  if (!expr) {
    switch (dialect) {
      case "postgres":
        expr = new PostgresExpression();
        break;
      case "mysql":
        expr = new MySqlExpression();
        break;
      case "sqlite":
        expr = new SqliteExpression();
        break;
    }
    cache.set(dialect, expr);
  }
  return expr;
}

/** @internal Reset cache. For testing only. */
export function resetDialectExpressionCache(): void {
  cache.clear();
}
