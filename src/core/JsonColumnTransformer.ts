import { Logger } from "../utils/Logger";

const logger = new Logger("JsonColumn");

/** Column types whose values should round-trip through JSON.stringify / JSON.parse. */
const JSON_COLUMN_TYPES = new Set(["json", "jsonb"]);

export function isJsonColumnType(type: string | undefined | null): boolean {
  return !!type && JSON_COLUMN_TYPES.has(type);
}

/**
 * Default write-side transform for `@Column({ type: "json" | "jsonb" })`.
 *
 * - null / undefined → pass through (preserves SQL NULL semantics)
 * - string → pass through (assumes user already serialized; do not double-encode)
 * - everything else → JSON.stringify
 *
 * Strings are passed through so legacy code that still does
 * `JSON.stringify(...)` manually continues to work without double-encoding.
 */
export function defaultJsonColumnWrite(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Default read-side transform for `@Column({ type: "json" | "jsonb" })`.
 *
 * - null / undefined → pass through
 * - string → JSON.parse; on SyntaxError, warn once and yield the raw string
 *   (legacy malformed rows must not crash a `find()`)
 * - object / array / other → pass through (pg jsonb already returns parsed values)
 */
export function makeDefaultJsonColumnRead(
  entityName: string,
  columnKey: string,
): (value: unknown) => unknown {
  let warnedOnce = false;
  return (value: unknown) => {
    if (value === null || value === undefined) return value;
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch (err) {
      if (!warnedOnce) {
        warnedOnce = true;
        logger.warn(
          `Failed to JSON.parse value for ${entityName}.${columnKey}: ${
            err instanceof Error ? err.message : String(err)
          }. Returning raw string. (Subsequent parse failures on this column are suppressed.)`,
        );
      }
      return value;
    }
  };
}

/**
 * Default read-side transform for `@Column({ type: "array" })`.
 *
 * MySQL and SQLite store the column as JSON text (the write side serializes
 * it there), so strings are parsed like a `json` column. pg returns a JS
 * array for the built-in element types, which passes through; a string that
 * opens with `{` is a PostgreSQL array literal pg did not parse (a custom
 * element type) and is returned unchanged, without a parse warning.
 */
export function makeDefaultArrayColumnRead(
  entityName: string,
  columnKey: string,
): (value: unknown) => unknown {
  const readJson = makeDefaultJsonColumnRead(entityName, columnKey);
  return (value: unknown) => {
    if (typeof value === "string" && value.startsWith("{")) return value;
    return readJson(value);
  };
}
