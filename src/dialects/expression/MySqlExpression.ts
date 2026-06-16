import sql, { raw, join } from "sql-template-tag";
import type { Sql } from "sql-template-tag";
import type {
  AggregateFilterOptions,
  ArrayOperator,
  CastKind,
  ColumnJsonMeta,
  DateAddUnit,
  DateComponent,
  DateTruncUnit,
  DialectExpression,
  FullTextSearchOptions,
  RegexMatchFlags,
} from "../DialectExpression";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { inlineFlagPrefix } from "../../core/expressions/RegexPattern";

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

  fullTextSearch(
    columns: string | readonly string[],
    query: string,
    optionsOrLanguage?: string | FullTextSearchOptions,
  ): Sql {
    const cols = Array.isArray(columns) ? columns : [columns as string];
    const opts: FullTextSearchOptions =
      typeof optionsOrLanguage === "string" || optionsOrLanguage === undefined
        ? {}
        : optionsOrLanguage;
    const modeKw = opts.mode === "natural" ? "NATURAL LANGUAGE" : "BOOLEAN";
    const colList = join(cols.map((c) => sql`${raw(c)}`), ", ");
    return sql`MATCH(${colList}) AGAINST(${query} IN ${raw(modeKw)} MODE)`;
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
      case "bigint":
        // MySQL SIGNED is 64-bit; no distinct 32-bit cast target.
        return "SIGNED";
      case "float":
        return "DECIMAL";
      case "boolean":
        return "UNSIGNED";
    }
  }

  stringIndexOf(haystack: Sql, needle: Sql): Sql {
    // MySQL LOCATE takes (needle, haystack) — reversed from STRPOS/INSTR.
    return sql`LOCATE(${needle}, ${haystack})`;
  }

  dateAdd(value: Sql, n: number, unit: DateAddUnit): Sql {
    // MySQL uses an unquoted INTERVAL keyword + value + unit keyword.
    // Injecting the unit via raw() because MySQL doesn't parameterize
    // interval units.
    const unitKw = mysqlUnitKeyword(unit);
    return sql`DATE_ADD(${value}, INTERVAL ${n} ${raw(unitKw)})`;
  }

  dateDiff(a: Sql, b: Sql, unit: DateAddUnit): Sql {
    // TIMESTAMPDIFF(UNIT, start, end) returns end - start.
    const unitKw = mysqlUnitKeyword(unit);
    return sql`TIMESTAMPDIFF(${raw(unitKw)}, ${b}, ${a})`;
  }

  random(): Sql {
    return sql`RAND()`;
  }

  dateTrunc(value: Sql, unit: DateTruncUnit): Sql {
    // MySQL has no native `date_trunc`, so each unit gets its own
    // explicit form. The `week` form matches PostgreSQL's ISO-Monday
    // semantics so cross-dialect callers get the same week-start date.
    switch (unit) {
      case "year":
        return sql`DATE_FORMAT(${value}, '%Y-01-01')`;
      case "quarter":
        return sql`DATE_ADD(MAKEDATE(YEAR(${value}), 1), INTERVAL (QUARTER(${value}) - 1) QUARTER)`;
      case "month":
        return sql`DATE_FORMAT(${value}, '%Y-%m-01')`;
      case "week":
        // WEEKDAY: Monday = 0 .. Sunday = 6.
        return sql`DATE(DATE_SUB(${value}, INTERVAL WEEKDAY(${value}) DAY))`;
      case "day":
        return sql`DATE(${value})`;
      case "hour":
        return sql`DATE_FORMAT(${value}, '%Y-%m-%d %H:00:00')`;
      case "minute":
        return sql`DATE_FORMAT(${value}, '%Y-%m-%d %H:%i:00')`;
      case "second":
        return sql`DATE_FORMAT(${value}, '%Y-%m-%d %H:%i:%s')`;
    }
  }

  dateComponent(value: Sql, component: DateComponent): Sql {
    const fn = mysqlDateFunction(component);
    return sql`${raw(fn)}(${value})`;
  }

  aggregateFilter(opts: AggregateFilterOptions): Sql {
    // MySQL has no FILTER clause — rewrite to the equivalent conditional
    // aggregate `FUNC(CASE WHEN condition THEN arg END)`. The CASE yields
    // NULL for non-matching rows, which every aggregate ignores, so the
    // result matches PostgreSQL/SQLite FILTER semantics. `COUNT(*)` has no
    // column argument, so substitute the literal `1` (a bare `*` is not a
    // valid CASE result expression).
    const { func, arg, isStar, distinct, condition } = opts;
    const caseArg = isStar ? sql`1` : arg;
    const caseExpr = sql`CASE WHEN ${condition} THEN ${caseArg} END`;
    const body = distinct ? sql`DISTINCT ${caseExpr}` : caseExpr;
    return sql`${raw(func)}(${body})`;
  }

  regexMatch(column: Sql, pattern: string, flags: RegexMatchFlags): Sql {
    // MySQL 8 / MariaDB 10.0.5+ ICU regex: `REGEXP`, inline `(?ims)` honored.
    return sql`${column} REGEXP ${inlineFlagPrefix(flags) + pattern}`;
  }

  arrayPredicate(
    _column: Sql,
    _operator: ArrayOperator,
    _values: unknown[],
  ): Sql {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      "Array operators (@>, &&, <@) are PostgreSQL-only — MySQL has no array " +
        "column type. Model the data as a JSON array and use the JSON path " +
        "DSL (e.g. col.contains(...)), or a junction table.",
    );
  }
}

function mysqlUnitKeyword(unit: DateAddUnit): string {
  switch (unit) {
    case "year":
      return "YEAR";
    case "month":
      return "MONTH";
    case "day":
      return "DAY";
    case "hour":
      return "HOUR";
    case "minute":
      return "MINUTE";
    case "second":
      return "SECOND";
  }
}

function mysqlDateFunction(component: DateComponent): string {
  switch (component) {
    case "year":
      return "YEAR";
    case "month":
      return "MONTH";
    case "day":
    case "dayOfMonth":
      return "DAYOFMONTH";
    case "hour":
      return "HOUR";
    case "minute":
      return "MINUTE";
    case "second":
      return "SECOND";
    case "dayOfWeek":
      return "DAYOFWEEK";
    case "dayOfYear":
      return "DAYOFYEAR";
    case "week":
      return "WEEK";
  }
}
