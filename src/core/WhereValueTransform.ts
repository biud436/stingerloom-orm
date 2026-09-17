import type { ColumnMetadata } from "../scanner/ColumnScanner";
import { ColumnTypeRegistry } from "./ColumnTypeRegistry";

/**
 * Converts a where operand from its domain value to its stored value.
 * Receives the where key (property name or DB column name).
 */
export type WhereValueTransform = (field: string, value: unknown) => unknown;

const cache = new WeakMap<object, WhereValueTransform | null>();

/**
 * The `transformer.to` step of an entity's columns, for where operands.
 *
 * A column written through `transformer.to` stores a different value than the
 * one the caller holds, so comparing against the raw operand asks the database
 * about a value it never stored. Only an explicit `@Column({ transformer })`
 * and a `ColumnTypeRegistry` custom type take part: the built-in JSON
 * serialization is a bind format, not a value mapping.
 *
 * Returns `undefined` when no column has a write transformer, so entities
 * without one pay nothing.
 */
export function buildWhereValueTransform(
  columns: readonly ColumnMetadata[] | undefined,
): WhereValueTransform | undefined {
  if (!columns) return undefined;
  const cached = cache.get(columns);
  if (cached !== undefined) return cached ?? undefined;

  const byField = new Map<string, (v: unknown) => unknown>();
  for (const col of columns) {
    const type = col.options?.type;
    const to =
      col.transformer?.to ??
      (type
        ? ColumnTypeRegistry.getInstance().getTransformer(type)?.to
        : undefined);
    if (!to) continue;
    const fn = to as (v: unknown) => unknown;
    if (col.propertyKey) byField.set(col.propertyKey, fn);
    if (!byField.has(col.name)) byField.set(col.name, fn);
  }

  const result: WhereValueTransform | null =
    byField.size === 0
      ? null
      : (field, value) => {
          const to = byField.get(field);
          return to ? to(value) : value;
        };
  cache.set(columns, result);
  return result ?? undefined;
}

/**
 * The `transformer.from` of one column, for mapping a min/max/sum/avg result
 * back to the domain value.
 */
export function findReadTransform(
  columns: readonly ColumnMetadata[] | undefined,
  field: string,
): ((v: unknown) => unknown) | undefined {
  const col = columns?.find(
    (c) => c.propertyKey === field || c.name === field,
  );
  if (!col) return undefined;
  const type = col.options?.type;
  return (col.transformer?.from ??
    (type
      ? ColumnTypeRegistry.getInstance().getTransformer(type)?.from
      : undefined)) as ((v: unknown) => unknown) | undefined;
}

const attached = new WeakMap<object, WhereValueTransform>();

/**
 * Ties an entity's where transform to its property-to-column map. Every
 * where path already carries that map to the resolver, so the transform
 * reaches find / count / aggregate / cursor / criteria writes / explain from
 * one place instead of a parameter on each call site.
 */
export function attachWhereValueTransform(
  propertyToColumn: Map<string, string>,
  columns: readonly ColumnMetadata[] | undefined,
): void {
  const transform = buildWhereValueTransform(columns);
  if (transform) attached.set(propertyToColumn, transform);
  if (columns) attachedColumns.set(propertyToColumn, columns);
}

const attachedColumns = new WeakMap<object, readonly ColumnMetadata[]>();

/**
 * Maps a SUM / AVG / MIN / MAX result back through the column's
 * `transformer.from`, so the aggregate is in the same representation as the
 * hydrated property. COUNT is a row count and never passes through here. A
 * result `from` does not turn into a finite number is returned untouched.
 */
export function aggregateFromStored(
  propertyToColumn: Map<string, string> | undefined,
  fn: string,
  field: string,
  value: number,
): number {
  if (!propertyToColumn || fn.toUpperCase() === "COUNT") return value;
  const from = findReadTransform(attachedColumns.get(propertyToColumn), field);
  if (!from) return value;
  const mapped = from(value);
  return typeof mapped === "number" && Number.isFinite(mapped) ? mapped : value;
}

export function attachedWhereValueTransform(
  propertyToColumn: Map<string, string> | undefined,
): WhereValueTransform | undefined {
  return propertyToColumn ? attached.get(propertyToColumn) : undefined;
}
