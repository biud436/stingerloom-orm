import type { RawValue } from "../../utils/sqlTag";
import type { WhereClause } from "../../dialects/FindOption";

/**
 * Structural view of an entity instance for metadata-driven property access.
 *
 * The write paths address entity properties by keys resolved at runtime from
 * the scanned column metadata, not from `keyof T` — so the access can never be
 * checked against the entity type. Modelling the target as
 * `Record<string, unknown>` keeps the *result* checked (reads come back as
 * `unknown` and must be narrowed) instead of erasing the whole expression to
 * `any`, which is what `(item as any)[key]` did.
 */
export type EntityFields = Record<string, unknown>;

/**
 * Structural view of an entity for dynamic property access.
 *
 * A type assertion only — there is no runtime conversion, so this costs
 * nothing beyond the (inlinable) call. In loops, hoist it once per item and
 * index the returned view rather than calling it per column.
 */
export function fieldsOf(entity: unknown): EntityFields {
  return entity as EntityFields;
}

/**
 * Widening cast at the SQL parameter boundary.
 *
 * Column values are `unknown` here because entity classes are user-defined,
 * while `sql-template-tag`'s `Value` union only models primitives and plain
 * records. Dates, Buffers and bigints do travel through it and are serialized
 * by the driver, so the union is narrower than reality — this helper is the
 * single documented place that gap is crossed, instead of an `any` at every
 * interpolation site.
 */
export function bindParam(value: unknown): RawValue {
  return value as RawValue;
}

/**
 * {@link bindParam} for a whole value list — one call per row instead of one
 * per cell. The multi-row INSERT paths build a value array per item, and a
 * per-cell call there is measurable on `insertMany` batches.
 */
export function bindParams(values: unknown[]): RawValue[] {
  return values as RawValue[];
}

/**
 * Builds a `WhereClause` from runtime-resolved property keys.
 *
 * `WhereClause<T>` is keyed by `keyof T`, which an object assembled from
 * metadata-derived string keys can never satisfy structurally. Confining the
 * assertion to this helper keeps the cast out of every `findOneInternal` call.
 */
export function whereByProps<T>(props: Record<string, unknown>): WhereClause<T> {
  return props as unknown as WhereClause<T>;
}

/** A row handed back by the driver, addressed by DB column name. */
export type DriverRow = Record<string, unknown>;

/** The MySQL/MariaDB OK-packet fields the write paths read. */
export interface DriverOkPacket {
  insertId?: number;
  affectedRows?: number;
}

/** The `better-sqlite3` `RunResult` fields the write paths read. */
export interface SqliteRunResult {
  lastInsertRowid?: number | bigint;
  changes?: number;
}

/**
 * What `session.query()` hands back, across dialects.
 *
 * `results` is a row array for SELECT and `RETURNING` statements, an OK packet
 * on the MySQL family, and a `RunResult` on SQLite. The write paths probe it
 * per dialect, so it is modelled as that union and read through the accessors
 * below rather than typed `any`.
 */
export interface DriverExecResult {
  results?: DriverRow[] | DriverOkPacket | SqliteRunResult | null;
  fields?: unknown;
  rowCount?: number;
}

/**
 * Rows of a SELECT / `RETURNING` result, or `[]` when the driver returned a
 * status packet instead.
 */
export function resultRows(result: DriverExecResult | undefined): DriverRow[] {
  const results = result?.results;
  return Array.isArray(results) ? results : [];
}

/**
 * The OK packet of a DML result (`insertId` / `affectedRows`), or `undefined`
 * when the driver returned rows instead — mirroring how `results.affectedRows`
 * simply read as `undefined` on a row array before.
 */
export function okPacket(
  result: DriverExecResult | undefined,
): DriverOkPacket | undefined {
  const results = result?.results;
  if (!results || Array.isArray(results)) return undefined;
  return results as DriverOkPacket;
}

/**
 * The SQLite `RunResult`. `better-sqlite3` surfaces it either nested under
 * `results` or as the bare object depending on the statement, and both shapes
 * reach here — so unwrap once, in one place.
 */
export function sqliteRunResult(result: unknown): SqliteRunResult | undefined {
  const nested = (result as { results?: unknown } | undefined)?.results;
  return (nested ?? result) as SqliteRunResult | undefined;
}
