import type { ColumnTransformer } from "../decorators/Column";
import { ColumnTypeRegistry } from "./ColumnTypeRegistry";
import {
  isJsonColumnType,
  makeDefaultArrayColumnRead,
  makeDefaultJsonColumnRead,
} from "./JsonColumnTransformer";
import {
  isTemporalColumnType,
  defaultTemporalColumnRead,
} from "./TemporalColumnTransformer";
import {
  type BigintMode,
  DEFAULT_BIGINT_MODE,
  makeBigintColumnRead,
} from "./BigintColumnTransformer";

/** Read-side (DB → JS) conversion for a single column value. */
export type ColumnRead = (raw: any) => any;

/**
 * The column facts that decide how a value is converted on read. Satisfied
 * by both decorator metadata (`ColumnMetadata`, flattened) and the
 * decorator-free `ColumnSchemaDef`.
 */
export interface ColumnReadSpec {
  type?: string;
  transformer?: ColumnTransformer;
  /** Deprecated one-way read transform (`@Column({ transform })`). */
  transform?: (raw: unknown) => unknown;
  bigintMode?: BigintMode;
}

/**
 * Resolves the read conversion for one column, or `undefined` when the
 * driver value is used as-is. Callers never pass SQL `NULL` (`null` /
 * `undefined`) to the returned function — NULL reads as NULL.
 *
 * This is the single rule set behind entity hydration and row shapes
 * (`defineRow`), so a column type reads the same way on both paths:
 *
 * - an explicit `transformer.from` (or legacy `transform`) wins;
 * - a custom type registered in {@link ColumnTypeRegistry} uses its `from`;
 * - `json` / `jsonb` parse string payloads (mysql2 / better-sqlite3), pg's
 *   parsed values pass through;
 * - `array` parses MySQL/SQLite JSON text, pg arrays pass through;
 * - `boolean` normalizes MySQL/SQLite `0/1` to a real boolean;
 * - temporal types parse better-sqlite3 TEXT into `Date`;
 * - `bigint` follows the column's `bigintMode`.
 *
 * @param owner - label for warnings/errors, e.g. the entity name
 * @param key - property key, used with `owner` in those messages
 */
export function resolveColumnRead(
  spec: ColumnReadSpec,
  owner: string,
  key: string,
): ColumnRead | undefined {
  if (spec.transformer?.from) return spec.transformer.from;
  if (spec.transform) return spec.transform;

  const type = spec.type;
  if (!type) return undefined;

  const regTransformer = ColumnTypeRegistry.getInstance().getTransformer(type);
  if (regTransformer?.from) return regTransformer.from;

  if (isJsonColumnType(type)) {
    // mysql2 / better-sqlite3 surface JSON columns as strings, while pg
    // jsonb already returns parsed values; the helper short-circuits the
    // non-string branch so it is a no-op for pg.
    return makeDefaultJsonColumnRead(owner, key);
  }
  if (type === "array") {
    // MySQL/SQLite store `type: "array"` as JSON text; pg already returns a
    // JS array for a native array column, which passes through.
    return makeDefaultArrayColumnRead(owner, key);
  }
  if (type === "boolean") {
    // MySQL/SQLite store booleans as 0/1 TINYINT; PostgreSQL returns
    // true/false already, in which case Boolean() is the identity.
    return (raw) => Boolean(raw);
  }
  if (isTemporalColumnType(type)) {
    // better-sqlite3 returns temporal columns as the stored TEXT while
    // pg/mysql2 return Date; normalize on read so the declared Date type
    // holds on every driver. Date values pass through, so this is a cheap
    // instanceof check on PostgreSQL/MySQL.
    return defaultTemporalColumnRead;
  }
  if (type === "bigint") {
    // Drivers deliver bigint losslessly but in different shapes (pg:
    // string, mysql2 / better-sqlite3: number when safe, string beyond
    // ±2^53). The column's bigintMode picks one JS-side type.
    return makeBigintColumnRead(
      spec.bigintMode ?? DEFAULT_BIGINT_MODE,
      owner,
      key,
    );
  }
  return undefined;
}
