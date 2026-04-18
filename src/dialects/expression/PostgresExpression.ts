import sql, { raw, join } from "sql-template-tag";
import type { Sql } from "sql-template-tag";
import type {
  CastKind,
  ColumnJsonMeta,
  DateAddUnit,
  DateComponent,
  DialectExpression,
} from "../DialectExpression";

export class PostgresExpression implements DialectExpression {
  readonly dialect = "postgres" as const;

  ilike(column: string, value: string): Sql {
    return sql`${raw(column)} ILIKE ${value}`;
  }

  caseInsensitiveLike(column: string, pattern: string): Sql {
    return sql`${raw(column)} ILIKE ${pattern} ESCAPE ${"\\"}`;
  }

  fullTextSearch(column: string, query: string, language?: string): Sql {
    const lang = language ?? "english";
    return sql`to_tsvector(${lang}, ${raw(column)}) @@ plainto_tsquery(${lang}, ${query})`;
  }

  /**
   * Build `ARRAY[$1, $2, ...]::text[]` from path segments. Used as fallback
   * for multi-segment paths where chained `->` would allocate intermediate
   * jsonb subtrees.
   */
  private pathArray(path: ReadonlyArray<string | number>): Sql {
    const segs = path.map((s) => sql`${String(s)}`);
    return sql`ARRAY[${join(segs, ", ")}]::text[]`;
  }

  /**
   * Navigate `path` starting at `column` using chained `->` operators,
   * returning the final jsonb sub-document. For jsonb columns this is
   * friendlier to expression-GIN indexes than `#>` on an ARRAY path and
   * lets numeric segments bind as integer array-index access.
   *
   * String segments are parameterized (safe for user-supplied keys).
   * Numeric segments are inlined as integer literals — otherwise node-pg
   * sends them with no type hint and PG falls back to the `jsonb -> text`
   * overload, which returns NULL against an array. Inlining is safe
   * because numeric segments originate from bounded JS integers
   * (`parseJsonPath` numeric indices / numeric proxy keys), never from
   * free-form user text.
   *
   * Caller must have already verified `path.length >= 1`.
   */
  private navigateJsonb(column: string, path: ReadonlyArray<string | number>): Sql {
    let acc: Sql = sql`${raw(column)}`;
    for (const seg of path) {
      acc = this.arrowStep(acc, seg, "->");
    }
    return acc;
  }

  /** @internal Append a single `-> seg` or `->> seg` hop. */
  private arrowStep(acc: Sql, seg: string | number, op: "->" | "->>"): Sql {
    if (typeof seg === "number") {
      // Integer literal — see `navigateJsonb` for the rationale.
      return sql`${acc} ${raw(op)} ${raw(String(Math.trunc(seg)))}`;
    }
    return sql`${acc} ${raw(op)} ${seg}`;
  }

  jsonExtract(
    column: string,
    path: ReadonlyArray<string | number>,
    asText: boolean,
    meta?: ColumnJsonMeta,
  ): Sql {
    if (path.length === 0) {
      return sql`${raw(column)}`;
    }
    // Single-segment fast path: use native -> / ->> operators. Works on both
    // json and jsonb, parameterizes one value instead of an N-element ARRAY,
    // and on jsonb is matchable against expression indexes like
    // `CREATE INDEX ON t USING gin ((profile -> 'tags'))`.
    if (path.length === 1) {
      const op = asText ? "->>" : "->";
      return this.arrowStep(sql`${raw(column)}`, path[0], op);
    }
    // Multi-segment on jsonb: chain `->` for nested navigation, then coerce
    // the final hop to text with `->>` when `asText` is requested. Chained
    // `->` preserves expression-GIN applicability on prefix subpaths.
    if (meta?.dbType === "jsonb") {
      const head = path.slice(0, -1);
      const tail = path[path.length - 1];
      const base = this.navigateJsonb(column, head);
      const tailOp = asText ? "->>" : "->";
      return this.arrowStep(base, tail, tailOp);
    }
    // Multi-segment on json (or unknown storage): keep #>>/#> with ARRAY
    // since native `@>` / expression GIN don't apply to json.
    const op = asText ? "#>>" : "#>";
    return sql`${raw(column)} ${raw(op)} ${this.pathArray(path)}`;
  }

  jsonContains(
    column: string,
    path: ReadonlyArray<string | number>,
    value: unknown,
    meta?: ColumnJsonMeta,
  ): Sql {
    // `to_jsonb(scalar)` binds the scalar as its native pg type and wraps it
    // without parsing a JSON literal — cheaper and placeholder-safe vs the
    // `'"x"'::jsonb` form. Only applied to true scalars; objects and arrays
    // still go through JSON.stringify + ::jsonb cast.
    const isScalar =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean";
    const isJsonb = meta?.dbType === "jsonb";

    if (path.length === 0) {
      if (isJsonb && isScalar) {
        return sql`${raw(column)} @> ${this.toJsonbScalar(value)}`;
      }
      const candidate = JSON.stringify(value);
      return sql`${raw(column)} @> ${candidate}::jsonb`;
    }

    if (isJsonb) {
      // Chained `-> ` navigation (`col -> 'k'` for single-seg, `col -> 'a' -> 'b'`
      // for nested) so prefix subpaths can be matched against expression-GIN
      // indexes like `CREATE INDEX ON t USING gin ((profile -> 'tags'))`.
      const base = this.navigateJsonb(column, path);
      if (isScalar) {
        return sql`${base} @> ${this.toJsonbScalar(value)}`;
      }
      const candidate = JSON.stringify(value);
      return sql`${base} @> ${candidate}::jsonb`;
    }

    // json (non-binary) column: no native containment, fall back to
    // `#>` with ARRAY path + candidate::jsonb cast (legacy behavior).
    const candidate = JSON.stringify(value);
    return sql`(${raw(column)} #> ${this.pathArray(path)}) @> ${candidate}::jsonb`;
  }

  /**
   * `to_jsonb($1)` where $1 is a plain node-pg parameter fails with
   * "could not determine polymorphic type because input has type unknown":
   * the function is `to_jsonb(anyelement)` and node-pg does not infer a
   * concrete type for bare scalar parameters. Cast the placeholder to the
   * matching pg type so the polymorphic resolver can pick the overload.
   */
  private toJsonbScalar(value: string | number | boolean): Sql {
    if (typeof value === "number") {
      return sql`to_jsonb(${value}::numeric)`;
    }
    if (typeof value === "boolean") {
      return sql`to_jsonb(${value}::bool)`;
    }
    return sql`to_jsonb(${value}::text)`;
  }

  jsonHasKey(
    column: string,
    path: ReadonlyArray<string | number>,
    key: string,
    meta?: ColumnJsonMeta,
  ): Sql {
    // Use `jsonb_exists()` rather than the `?` operator: the operator collides
    // with sql-template-tag's `?` parameter placeholder, which the Postgres
    // connector rewrites to `$N` unconditionally.
    if (path.length === 0) {
      return sql`jsonb_exists(${raw(column)}, ${key})`;
    }
    if (path.length === 1) {
      const navigated = this.arrowStep(sql`${raw(column)}`, path[0], "->");
      return sql`jsonb_exists(${navigated}, ${key})`;
    }
    if (meta?.dbType === "jsonb") {
      return sql`jsonb_exists(${this.navigateJsonb(column, path)}, ${key})`;
    }
    return sql`jsonb_exists(${raw(column)} #> ${this.pathArray(path)}, ${key})`;
  }

  jsonArrayLength(
    column: string,
    path: ReadonlyArray<string | number>,
    meta?: ColumnJsonMeta,
  ): Sql {
    if (path.length === 0) {
      return sql`jsonb_array_length(${raw(column)})`;
    }
    if (path.length === 1) {
      const navigated = this.arrowStep(sql`${raw(column)}`, path[0], "->");
      return sql`jsonb_array_length(${navigated})`;
    }
    if (meta?.dbType === "jsonb") {
      return sql`jsonb_array_length(${this.navigateJsonb(column, path)})`;
    }
    return sql`jsonb_array_length(${raw(column)} #> ${this.pathArray(path)})`;
  }

  jsonTypeOf(
    column: string,
    path: ReadonlyArray<string | number>,
    meta?: ColumnJsonMeta,
  ): Sql {
    if (path.length === 0) {
      return sql`jsonb_typeof(${raw(column)})`;
    }
    if (path.length === 1) {
      const navigated = this.arrowStep(sql`${raw(column)}`, path[0], "->");
      return sql`jsonb_typeof(${navigated})`;
    }
    if (meta?.dbType === "jsonb") {
      return sql`jsonb_typeof(${this.navigateJsonb(column, path)})`;
    }
    return sql`jsonb_typeof(${raw(column)} #> ${this.pathArray(path)})`;
  }

  castTypeName(kind: CastKind): string {
    switch (kind) {
      case "string":
        return "TEXT";
      case "int":
        return "INTEGER";
      case "long":
        return "BIGINT";
      case "float":
        return "REAL";
      case "boolean":
        return "BOOLEAN";
    }
  }

  stringIndexOf(haystack: Sql, needle: Sql): Sql {
    return sql`STRPOS(${haystack}, ${needle})`;
  }

  dateAdd(value: Sql, n: number, unit: DateAddUnit): Sql {
    // `value + (N * INTERVAL '1 unit')` — the literal is injected as
    // raw SQL because PostgreSQL does not accept a parameter for the
    // INTERVAL type specifier.
    const literal = pgIntervalLiteral(unit);
    return sql`(${value} + (${n} * INTERVAL ${raw(literal)}))`;
  }

  dateDiff(a: Sql, b: Sql, unit: DateAddUnit): Sql {
    if (unit === "year") {
      return sql`CAST(EXTRACT(YEAR FROM age(${a}, ${b})) AS INTEGER)`;
    }
    if (unit === "month") {
      return sql`CAST(
        EXTRACT(YEAR FROM age(${a}, ${b})) * 12
        + EXTRACT(MONTH FROM age(${a}, ${b}))
      AS INTEGER)`;
    }
    const factor = secondsPerUnit(unit);
    return sql`CAST(EXTRACT(EPOCH FROM (${a} - ${b})) / ${factor} AS INTEGER)`;
  }

  random(): Sql {
    return sql`RANDOM()`;
  }

  dateComponent(value: Sql, component: DateComponent): Sql {
    // PostgreSQL EXTRACT returns a numeric — cast to integer so
    // downstream comparisons stay on integer arithmetic.
    const field = pgExtractField(component);
    return sql`CAST(EXTRACT(${raw(field)} FROM ${value}) AS INTEGER)`;
  }
}

function pgIntervalLiteral(unit: DateAddUnit): string {
  switch (unit) {
    case "year":
      return "'1 year'";
    case "month":
      return "'1 month'";
    case "day":
      return "'1 day'";
    case "hour":
      return "'1 hour'";
    case "minute":
      return "'1 minute'";
    case "second":
      return "'1 second'";
  }
}

function secondsPerUnit(unit: DateAddUnit): number {
  switch (unit) {
    case "day":
      return 86400;
    case "hour":
      return 3600;
    case "minute":
      return 60;
    case "second":
      return 1;
    default:
      throw new Error(`Unsupported unit for seconds-based diff: ${unit}`);
  }
}

function pgExtractField(component: DateComponent): string {
  switch (component) {
    case "year":
      return "YEAR";
    case "month":
      return "MONTH";
    case "day":
    case "dayOfMonth":
      return "DAY";
    case "hour":
      return "HOUR";
    case "minute":
      return "MINUTE";
    case "second":
      return "SECOND";
    case "dayOfWeek":
      return "DOW";
    case "dayOfYear":
      return "DOY";
    case "week":
      return "WEEK";
  }
}
