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
   * Caller must have already verified `path.length >= 1`.
   */
  private navigateJsonb(column: string, path: ReadonlyArray<string | number>): Sql {
    let acc: Sql = sql`${raw(column)}`;
    for (const seg of path) {
      if (typeof seg === "number") {
        acc = sql`${acc} -> ${seg}`;
      } else {
        acc = sql`${acc} -> ${seg}`;
      }
    }
    return acc;
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
      const seg = path[0];
      const op = asText ? "->>" : "->";
      return sql`${raw(column)} ${raw(op)} ${
        typeof seg === "number" ? seg : seg
      }`;
    }
    // Multi-segment on jsonb: chain `->` for nested navigation, then coerce
    // the final hop to text with `->>` when `asText` is requested. Chained
    // `->` preserves expression-GIN applicability on prefix subpaths.
    if (meta?.dbType === "jsonb") {
      const head = path.slice(0, -1);
      const tail = path[path.length - 1];
      const base = this.navigateJsonb(column, head);
      const tailOp = asText ? "->>" : "->";
      return sql`${base} ${raw(tailOp)} ${typeof tail === "number" ? tail : tail}`;
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
        return sql`${raw(column)} @> to_jsonb(${value as string | number | boolean})`;
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
        return sql`${base} @> to_jsonb(${value as string | number | boolean})`;
      }
      const candidate = JSON.stringify(value);
      return sql`${base} @> ${candidate}::jsonb`;
    }

    // json (non-binary) column: no native containment, fall back to
    // `#>` with ARRAY path + candidate::jsonb cast (legacy behavior).
    const candidate = JSON.stringify(value);
    return sql`(${raw(column)} #> ${this.pathArray(path)}) @> ${candidate}::jsonb`;
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
      const seg = path[0];
      return sql`jsonb_exists(${raw(column)} -> ${
        typeof seg === "number" ? seg : seg
      }, ${key})`;
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
      const seg = path[0];
      return sql`jsonb_array_length(${raw(column)} -> ${
        typeof seg === "number" ? seg : seg
      })`;
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
      const seg = path[0];
      return sql`jsonb_typeof(${raw(column)} -> ${
        typeof seg === "number" ? seg : seg
      })`;
    }
    if (meta?.dbType === "jsonb") {
      return sql`jsonb_typeof(${this.navigateJsonb(column, path)})`;
    }
    return sql`jsonb_typeof(${raw(column)} #> ${this.pathArray(path)})`;
  }
}
