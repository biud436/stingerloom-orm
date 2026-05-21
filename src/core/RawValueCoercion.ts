/**
 * Per-column value coercion for `getRawMany()` / `getRawOne()`.
 *
 * Drivers surface raw query results in dialect- and option-dependent
 * shapes: `mysql2` returns `BIGINT` / `DECIMAL` columns as strings, the
 * `pg` driver returns `DECIMAL` / `NUMERIC` as strings, dates arrive as
 * `Date` or string depending on driver options, and JSON columns may or
 * may not be parsed. Aggregate / analytics queries hit all of these.
 *
 * The coerce layer lets a caller declare the intended primitive per
 * column once, so application code stops hand-writing
 * `Number(row.x)` / `row.d instanceof Date ? … : …` blocks.
 */

/** Primitive type tag for a single coerced column. */
export type CoerceType =
  | "number"
  | "bigint"
  | "string"
  | "date"
  | "json"
  | "boolean";

/**
 * Column-name → {@link CoerceType} map. Every key is optional; columns
 * not listed are returned with the driver's native value untouched.
 */
export type CoerceMap<T> = {
  [K in keyof T]?: CoerceType;
};

/** Options accepted by `getRawMany()` / `getRawOne()`. */
export interface RawResultOptions<T> {
  /**
   * Per-column coercion map. Each listed column's driver-native value is
   * normalized to the tagged primitive. `null` / `undefined` pass through
   * untouched; unlisted columns are returned verbatim.
   *
   * @example
   * ```ts
   * .getRawMany<{ day: Date; completedCount: number }>({
   *   coerce: { day: "date", completedCount: "number" },
   * });
   * ```
   */
  coerce?: CoerceMap<T>;
}

/**
 * Coerce a single driver-native value to the requested primitive.
 *
 * `null` / `undefined` always pass through so SQL NULL semantics are
 * preserved (a nullable aggregate stays nullable).
 *
 * - `number`  — `Number(v)`; handles `mysql2` BIGINT-as-string and
 *   `pg` DECIMAL/NUMERIC-as-string. Use `bigint` instead when the value
 *   can exceed `Number.MAX_SAFE_INTEGER`.
 * - `bigint`  — `BigInt(v)`; for integer columns wider than 53 bits.
 * - `string`  — `String(v)`.
 * - `date`    — wraps non-`Date` values in `new Date(v)`.
 * - `json`    — `JSON.parse` when the value is a string, otherwise
 *   passes through (the `pg` driver already parses `json`/`jsonb`).
 * - `boolean` — normalizes `0/1`, `"0"/"1"`, `"true"/"false"` and real
 *   booleans (MySQL/SQLite store booleans as `TINYINT` 0/1).
 */
function coerceValue(value: unknown, type: CoerceType): unknown {
  if (value === null || value === undefined) return value;

  switch (type) {
    case "number":
      return typeof value === "number" ? value : Number(value);
    case "bigint":
      return typeof value === "bigint" ? value : BigInt(value as never);
    case "string":
      return typeof value === "string" ? value : String(value);
    case "date":
      return value instanceof Date ? value : new Date(value as never);
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
    case "boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string")
        return value === "1" || value.toLowerCase() === "true";
      return Boolean(value);
    default:
      return value;
  }
}

/**
 * Apply a {@link CoerceMap} to a single raw row, returning a shallow copy
 * with the listed columns coerced. The input row is not mutated.
 *
 * @throws when a converter fails (e.g. `BigInt("abc")`), with a message
 *   naming the offending column, type tag, and value.
 */
export function coerceRow<T>(
  row: Record<string, unknown>,
  coerce: CoerceMap<T>,
): T {
  const out: Record<string, unknown> = { ...row };
  for (const key in coerce) {
    const type = coerce[key as keyof T];
    if (!type || !(key in out)) continue;
    try {
      out[key] = coerceValue(out[key], type);
    } catch (err) {
      throw new Error(
        `getRawMany: failed to coerce column "${key}" to "${type}" ` +
          `(value: ${String(out[key])}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return out as T;
}

/** Apply a {@link CoerceMap} to every row in a raw result set. */
export function coerceRows<T>(
  rows: Record<string, unknown>[],
  coerce: CoerceMap<T>,
): T[] {
  return rows.map((row) => coerceRow<T>(row, coerce));
}
