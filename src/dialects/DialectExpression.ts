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
   * - PostgreSQL: `to_tsvector('lang', col) @@ plainto_tsquery('lang', query)`.
   *   Multi-column form composes `COALESCE(c1, '') || ' ' || COALESCE(c2, '')`
   *   inside the tsvector so a single GIN expression index can serve the predicate.
   * - MySQL: `MATCH(c1, c2) AGAINST(query IN <mode> MODE)` — `boolean` (default)
   *   or `natural` (natural language).
   * - SQLite: throws (use FTS5 virtual tables with raw queries).
   *
   * @param columns - One already-escaped column identifier or an array of them.
   * @param query - The search query string (parameterized).
   * @param optionsOrLanguage - Either an options object or, for back-compat, a
   *                            PostgreSQL text search config string.
   */
  fullTextSearch(
    columns: string | readonly string[],
    query: string,
    optionsOrLanguage?: string | FullTextSearchOptions,
  ): Sql;

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

  /**
   * Render a case-sensitive substring-search position for `needle`
   * inside `haystack`, returning the SQL 1-based position (or `0` when
   * not found). The caller is expected to subtract 1 to match JS
   * `indexOf` semantics (0-based with `-1` for "not found").
   *
   * - PostgreSQL: `STRPOS(haystack, needle)`
   * - MySQL: `LOCATE(needle, haystack)`
   * - SQLite: `INSTR(haystack, needle)`
   */
  stringIndexOf(haystack: Sql, needle: Sql): Sql;

  /**
   * Render date addition: `value + n units` as a date/timestamp.
   *
   * - PostgreSQL: `value + (N * INTERVAL '1 day')` (or similar)
   * - MySQL: `DATE_ADD(value, INTERVAL N DAY)`
   * - SQLite: `datetime(value, '+N days')`
   *
   * @param n can be negative for subtraction (`addDays(-7)`).
   */
  dateAdd(value: Sql, n: number, unit: DateAddUnit): Sql;

  /**
   * Render `dateDiff(a, b, unit)` — `(a - b)` in the requested unit.
   *
   * - PostgreSQL: `EXTRACT(epoch FROM (a - b)) / factor` or age()
   * - MySQL: `TIMESTAMPDIFF(UNIT, b, a)`
   * - SQLite: `CAST((julianday(a) - julianday(b)) * factor AS INTEGER)`
   */
  dateDiff(a: Sql, b: Sql, unit: DateAddUnit): Sql;

  /**
   * Render `RANDOM()` / `RAND()` — a scalar in `[0, 1)` (PG/SQLite) or
   * `[0, 1)` / engine-specific range. Wrap in `ORDER BY` for random
   * sampling.
   */
  random(): Sql;

  /**
   * Truncate a date/timestamp to the start of the requested calendar
   * unit — analogous to PostgreSQL's `date_trunc('week', ts)`.
   *
   * Engine mapping:
   * - PostgreSQL: `date_trunc('<unit>', value)` (ISO week starts Monday).
   * - MySQL: explicit equivalents — `DATE(value)` for day,
   *   `DATE(DATE_SUB(value, INTERVAL WEEKDAY(value) DAY))` for week
   *   (ISO-Monday-aligned), `DATE_FORMAT(value, '%Y-%m-01')` for month,
   *   etc.
   * - SQLite: `date(value, 'start of <unit>')` / strftime equivalents.
   *
   * Returns the truncated value as a date or timestamp (engine-specific —
   * callers that need a stable text form should cast or format explicitly).
   */
  dateTrunc(value: Sql, unit: DateTruncUnit): Sql;

  /**
   * Render a date/time component extraction on `value` — e.g.
   * `YEAR(col)` (MySQL), `EXTRACT(YEAR FROM col)` (PostgreSQL),
   * `CAST(strftime('%Y', col) AS INTEGER)` (SQLite).
   *
   * The `value` is pre-rendered (already a `Sql` fragment) so callers
   * can pass column references, other scalar expressions, or function
   * calls without worrying about dialect-specific quoting.
   *
   * Component mapping:
   * - `year`: 4-digit year
   * - `month`: 1–12
   * - `day`: alias of `dayOfMonth`, 1–31
   * - `hour`: 0–23
   * - `minute`: 0–59
   * - `second`: 0–59 (or 60 for leap seconds on some engines)
   * - `dayOfWeek`: engine-dependent encoding (MySQL 1=Sun…7=Sat,
   *   PostgreSQL 0=Sun…6=Sat, SQLite same as PG). Prefer explicit
   *   ISO-aware logic if portability matters.
   * - `dayOfMonth`: 1–31
   * - `dayOfYear`: 1–366
   * - `week`: engine-dependent week-of-year.
   */
  dateComponent(value: Sql, component: DateComponent): Sql;
}

/**
 * Options for {@link DialectExpression.fullTextSearch}.
 *
 * `language` applies to PostgreSQL only (text search config, default
 * `"english"`). `mode` applies to MySQL only and selects between
 * `IN BOOLEAN MODE` (default) and `IN NATURAL LANGUAGE MODE`.
 */
export interface FullTextSearchOptions {
  /** PostgreSQL text search configuration. Default: `"english"`. */
  language?: string;
  /** MySQL match mode. Default: `"boolean"`. */
  mode?: "natural" | "boolean";
}

/**
 * Supported CAST target kinds for the `.stringValue()` /
 * `.intValue()` / `.bigintValue()` family. Resolved to a dialect-
 * specific SQL type name by {@link DialectExpression.castTypeName}.
 */
export type CastKind =
  | "string"
  | "int"
  | "long"
  | "float"
  | "boolean"
  | "bigint";

/**
 * Supported units for `dateAdd` / `dateDiff` helpers. Day, month,
 * year are calendar-aware where the engine supports it; hour, minute,
 * second are straight time deltas.
 */
export type DateAddUnit =
  | "year"
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "second";

/**
 * Supported date-component extraction kinds. Resolved to dialect-
 * specific SQL by {@link DialectExpression.dateComponent}.
 */
export type DateComponent =
  | "year"
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "second"
  | "dayOfWeek"
  | "dayOfMonth"
  | "dayOfYear"
  | "week";

/**
 * Truncation granularities for {@link DialectExpression.dateTrunc}. `week`
 * follows the ISO convention (Monday). Sub-second units are not supported —
 * engine support is too fragmented to make a portable promise.
 */
export type DateTruncUnit =
  | "year"
  | "quarter"
  | "month"
  | "week"
  | "day"
  | "hour"
  | "minute"
  | "second";

/** Singleton cache — implementations are stateless. */
const cache = new Map<DialectName, DialectExpression>();

/**
 * Creates or retrieves a cached {@link DialectExpression} for the given dialect.
 *
 * Follows the same factory pattern as `createColumnDefinitionBuilder()`.
 */
export function createDialectExpression(
  dialect: DialectName,
): DialectExpression {
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
