import sql, { raw } from "sql-template-tag";
import type { Sql } from "sql-template-tag";
import { inlineFlagPrefix } from "../../core/expressions/RegexPattern";
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

  /**
   * Guaranteed case-insensitive LIKE. SQLite's built-in LIKE is ASCII-only
   * case-folding; wrapping in `LOWER()` extends coverage for ASCII values
   * consistently with MySQL's fallback. Non-ASCII Unicode still requires
   * the ICU extension — documented on the `*IgnoreCase` helpers.
   */
  caseInsensitiveLike(column: string, pattern: string): Sql {
    return sql`LOWER(${raw(column)}) LIKE LOWER(${pattern}) ESCAPE ${"\\"}`;
  }

  fullTextSearch(
    _columns: string | readonly string[],
    _query: string,
    _optionsOrLanguage?: string | FullTextSearchOptions,
  ): Sql {
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

  castTypeName(kind: CastKind): string {
    switch (kind) {
      case "string":
        return "TEXT";
      case "int":
      case "long":
      case "bigint":
        // SQLite INTEGER is already 64-bit.
        return "INTEGER";
      case "float":
        return "REAL";
      case "boolean":
        return "INTEGER";
    }
  }

  stringIndexOf(haystack: Sql, needle: Sql): Sql {
    return sql`INSTR(${haystack}, ${needle})`;
  }

  dateAdd(value: Sql, n: number, unit: DateAddUnit): Sql {
    // SQLite uses modifier strings: '+N days', '+N months', etc.
    // The modifier must be a bound string parameter.
    const modifier = sqliteModifier(n, unit);
    return sql`datetime(${value}, ${modifier})`;
  }

  dateDiff(a: Sql, b: Sql, unit: DateAddUnit): Sql {
    if (unit === "year") {
      return sql`CAST((julianday(${a}) - julianday(${b})) / 365.25 AS INTEGER)`;
    }
    if (unit === "month") {
      return sql`CAST((julianday(${a}) - julianday(${b})) / 30.4375 AS INTEGER)`;
    }
    const factor = juliandayFactor(unit);
    return sql`CAST((julianday(${a}) - julianday(${b})) * ${factor} AS INTEGER)`;
  }

  random(): Sql {
    return sql`RANDOM()`;
  }

  dateTrunc(value: Sql, unit: DateTruncUnit): Sql {
    // SQLite has no `date_trunc`, but `date()` + the `start of …` /
    // `weekday 0` modifiers cover the common cases. Quarter falls back
    // to month-of-quarter math via strftime.
    switch (unit) {
      case "year":
        return sql`date(${value}, 'start of year')`;
      case "quarter":
        // Truncate to the first day of the quarter: start of year + 3 * floor((month-1)/3) months.
        return sql`date(${value}, 'start of year', '+' || ((CAST(strftime('%m', ${value}) AS INTEGER) - 1) / 3 * 3) || ' months')`;
      case "month":
        return sql`date(${value}, 'start of month')`;
      case "week":
        // ISO week starts Monday. SQLite's `%w` is 0=Sunday..6=Saturday,
        // so `(w + 6) % 7` gives the 0-based weekday with Monday=0;
        // subtract that many days to land on Monday.
        return sql`date(${value}, '-' || ((CAST(strftime('%w', ${value}) AS INTEGER) + 6) % 7) || ' days')`;
      case "day":
        return sql`date(${value}, 'start of day')`;
      case "hour":
        return sql`strftime('%Y-%m-%d %H:00:00', ${value})`;
      case "minute":
        return sql`strftime('%Y-%m-%d %H:%M:00', ${value})`;
      case "second":
        return sql`strftime('%Y-%m-%d %H:%M:%S', ${value})`;
    }
  }

  dateComponent(value: Sql, component: DateComponent): Sql {
    const format = sqliteStrftimeFormat(component);
    return sql`CAST(strftime(${format}, ${value}) AS INTEGER)`;
  }

  aggregateFilter(opts: AggregateFilterOptions): Sql {
    // SQLite (>= 3.30) supports the SQL-standard FILTER clause natively.
    const { func, arg, distinct, condition } = opts;
    const body = distinct ? sql`DISTINCT ${arg}` : arg;
    return sql`${raw(func)}(${body}) FILTER (WHERE ${condition})`;
  }

  regexMatch(column: Sql, pattern: string, flags: RegexMatchFlags): Sql {
    // SQLite reserves REGEXP but ships no engine — SqliteConnector registers
    // a `regexp` UDF that runs the pattern (inline `(?ims)` prefix included)
    // through a JS RegExp.
    return sql`${column} REGEXP ${inlineFlagPrefix(flags) + pattern}`;
  }

  arrayPredicate(
    _column: Sql,
    _operator: ArrayOperator,
    _values: unknown[],
  ): Sql {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      "Array operators (@>, &&, <@) are PostgreSQL-only — SQLite has no array " +
        "column type. Model the data as a JSON array and use the JSON path " +
        "DSL (e.g. col.contains(...)), or a junction table.",
    );
  }
}

function sqliteModifier(n: number, unit: DateAddUnit): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  const noun =
    unit === "year"
      ? "years"
      : unit === "month"
        ? "months"
        : unit === "day"
          ? "days"
          : unit === "hour"
            ? "hours"
            : unit === "minute"
              ? "minutes"
              : "seconds";
  return `${sign}${abs} ${noun}`;
}

function juliandayFactor(unit: DateAddUnit): number {
  switch (unit) {
    case "day":
      return 1;
    case "hour":
      return 24;
    case "minute":
      return 1440;
    case "second":
      return 86400;
    default:
      // Year/month go through the dedicated branches in `dateDiff`; this
      // helper is only reached for fixed-length units. Any other unit means
      // the caller asked for something julianday can't express directly.
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        `dateDiff(unit=${unit as string}) cannot be expressed as a julianday-factor ` +
          "computation on SQLite — month/year are not fixed-length. Use the dedicated " +
          "'year'/'month' branch in SqliteExpression.dateDiff, or compute the interval " +
          "yourself with strftime().",
      );
  }
}

function sqliteStrftimeFormat(component: DateComponent): string {
  switch (component) {
    case "year":
      return "%Y";
    case "month":
      return "%m";
    case "day":
    case "dayOfMonth":
      return "%d";
    case "hour":
      return "%H";
    case "minute":
      return "%M";
    case "second":
      return "%S";
    case "dayOfWeek":
      // strftime %w: 0=Sunday..6=Saturday (matches PG DOW for 0..6).
      return "%w";
    case "dayOfYear":
      return "%j";
    case "week":
      // %W = week 0..53 (Monday as first day). Closest portable match.
      return "%W";
  }
}
