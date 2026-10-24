/* eslint-disable @typescript-eslint/no-explicit-any */
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import type { ColumnReadSpec } from "../core/ColumnReadTransform";
import {
  ColumnBuilder,
  ComputedBuilder,
  RelationBuilder,
  SchemaBuilder,
} from "./builders";
import { describeInvalidBuilder } from "./builderErrors";

/** A map of result property name → column builder, for {@link defineRow}. */
export type RowColumns = Record<string, ColumnBuilder<any>>;

type Prettify<T> = { [K in keyof T]: T[K] } & {};

/** The row type a {@link RowColumns} map describes — every field required. */
export type InferRowColumns<Cols extends RowColumns> = Prettify<{
  [K in keyof Cols]: Cols[K] extends SchemaBuilder<infer T, any> ? T : never;
}>;

/**
 * Brand under which a row shape keeps its field list. Registered with
 * `Symbol.for` so a shape built by the ESM copy of the package is still
 * recognized by the CJS copy (and vice versa).
 *
 * @internal Package-internal — not a public API.
 */
export const ROW_SHAPE_FIELDS: unique symbol = Symbol.for(
  "@stingerloom/orm:row-shape",
);

/**
 * One declared result column of a row shape.
 *
 * @internal Package-internal — not a public API.
 */
export interface RowShapeField {
  /** Property key on the returned row. */
  readonly key: string;
  /** Result column the value is read from (`.name()`, else `key`). */
  readonly column: string;
  /** Column facts that pick the read conversion. */
  readonly spec: ColumnReadSpec;
}

/**
 * The typed description of a raw result row, returned by {@link defineRow}.
 *
 * It is a plain value: defining one registers nothing with the ORM — no
 * entity metadata, no table, no schema synchronization. It only takes effect
 * when passed to `em.query(shape)`.
 */
export interface RowShape<Row> {
  /** Label used in error messages (`defineRow(columns, { name })`). */
  readonly name: string;
  /** @internal Declared result columns, in declaration order. */
  readonly [ROW_SHAPE_FIELDS]: readonly RowShapeField[];
  /** Phantom: the inferred row type. Absent at runtime. */
  readonly __stinger_row?: Row;
}

/**
 * Recovers the row type of a shape built with {@link defineRow}.
 *
 * @example
 * ```ts
 * const CachedLocation = defineRow({ id: t.int(), x: t.double() });
 * type CachedLocation = InferRow<typeof CachedLocation>; // { id: number; x: number }
 * ```
 */
export type InferRow<S> = S extends RowShape<infer Row> ? Row : never;

/** Tagged-template runner returned by `em.query(shape)`. */
export type RowQuery<Row> = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Row[]>;

/** Options for {@link defineRow}. */
export interface DefineRowOptions {
  /** Label used in error messages. Default: `"row"`. */
  name?: string;
}

/**
 * Describes the rows a raw SQL query returns, without mapping a table.
 *
 * Use it for tables the ORM does not manage (or one-off result shapes such as
 * reports): declare each result column with the same {@link t} builders
 * `defineEntity` uses, then pass the shape to `em.query`. The rows come back
 * typed, and each declared column is converted the way an entity column of
 * that type is — `Date` for temporal columns on SQLite, parsed JSON on
 * MySQL/SQLite, real booleans for `0/1`, `bigint` per its mode — plus numeric
 * strings (PostgreSQL `NUMERIC`, `COUNT(*)`) read as numbers.
 *
 * - `.name("db_column")` reads the field from a differently named column.
 * - `.nullable()` widens the field type to `T | null`.
 * - Modifiers that only describe DDL or writes (`primary`, `index`,
 *   `default`, `length`, …) are accepted, so a field map can be shared with
 *   `defineEntity`, and have no effect here.
 * - Columns the query returns but the shape does not declare are passed
 *   through untouched; they are not part of the inferred type.
 * - A declared column missing from the result throws, naming it.
 *
 * Nothing is registered: a shape that is never queried costs nothing beyond
 * the object itself, and the per-column read plan is built on first use.
 *
 * @example
 * ```ts
 * const CachedLocation = defineRow({
 *   id:       t.int(),
 *   x:        t.double(),
 *   y:        t.double(),
 *   cachedAt: t.datetime().name("cached_at"),
 * });
 *
 * const [loc] = await em.query(CachedLocation)`
 *   SELECT * FROM cached_location WHERE id = ${16}
 * `;
 * // loc: { id: number; x: number; y: number; cachedAt: Date }
 * ```
 */
export function defineRow<Cols extends RowColumns>(
  columns: Cols,
  options: DefineRowOptions = {},
): RowShape<InferRowColumns<Cols>> {
  const name = options.name ?? "row";
  const fields: RowShapeField[] = [];
  const keyByColumn = new Map<string, string>();

  for (const [key, builder] of Object.entries(columns) as [string, unknown][]) {
    if (!(builder instanceof ColumnBuilder)) {
      throw new OrmError(
        OrmErrorCode.SCHEMA_ERROR,
        `defineRow("${name}"): field "${key}" is not a column builder — ` +
          describeNonColumn(builder),
        nonColumnHint(builder, key),
      );
    }

    const def = builder._def;
    const column = def.name ?? key;
    const claimedBy = keyByColumn.get(column);
    if (claimedBy !== undefined) {
      throw new OrmError(
        OrmErrorCode.SCHEMA_ERROR,
        `defineRow("${name}"): fields "${claimedBy}" and "${key}" both read ` +
          `the result column "${column}".`,
        `Give each field its own column, or select the column twice under ` +
          `different aliases.`,
      );
    }
    keyByColumn.set(column, key);

    fields.push(
      Object.freeze({
        key,
        column,
        spec: Object.freeze({
          type: def.type,
          transformer: def.transformer,
          transform: def.transform,
          bigintMode: def.bigintMode,
        }),
      }),
    );
  }

  return Object.freeze({
    name,
    [ROW_SHAPE_FIELDS]: Object.freeze(fields),
  }) as RowShape<InferRowColumns<Cols>>;
}

/** True when `value` is a shape built by {@link defineRow}. */
export function isRowShape(value: unknown): value is RowShape<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as any)[ROW_SHAPE_FIELDS])
  );
}

function describeNonColumn(value: unknown): string {
  if (value instanceof RelationBuilder) return "got a relation builder.";
  if (value instanceof ComputedBuilder) return "got a computed-column builder.";
  return describeInvalidBuilder(value);
}

function nonColumnHint(value: unknown, key: string): string {
  if (value instanceof RelationBuilder) {
    return (
      "A raw row is flat: select the foreign-key column and declare it with " +
      `its type (e.g. ${key}Id: t.int()), or query the table as an entity.`
    );
  }
  if (value instanceof ComputedBuilder) {
    return (
      "Write the expression in the SQL and declare the type of its result " +
      `(e.g. ${key}: t.double()).`
    );
  }
  return `Every field must be a called t.* column builder, e.g. ${key}: t.varchar().`;
}
