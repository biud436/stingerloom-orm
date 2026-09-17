/* eslint-disable @typescript-eslint/no-explicit-any */
import { COLUMN_TOKEN } from "../decorators/Column";
import type { ColumnMetadata } from "../scanner/ColumnScanner";
import type { ClazzType } from "../utils";

/**
 * Bookkeeping for the tenant column the "tenant_column" strategy adds to an
 * entity that does not declare one.
 *
 * The column is appended to the entity's shared column metadata, which every
 * connection registering the class reads. Without a way back, a class once
 * registered under "tenant_column" kept the column for the rest of the
 * process: a later connection without the strategy created the table with a
 * NOT NULL tenant column and every INSERT failed.
 *
 * Injected columns are marked, counted per class, and removed when the last
 * connection that injected them shuts down. A connection without the strategy
 * also drops a marked column no live connection holds (left by an
 * EntityManager that was never shut down).
 */
const INJECTED = Symbol.for("stingerloom:tenantColumnInjected");

const holders = new WeakMap<Function, number>();

export function markInjectedTenantColumn<C extends object>(column: C): C {
  (column as any)[INJECTED] = true;
  return column;
}

export function isInjectedTenantColumn(column: unknown): boolean {
  return !!column && (column as any)[INJECTED] === true;
}

export function retainInjectedTenantColumn(entity: ClazzType<any>): void {
  holders.set(entity, (holders.get(entity) ?? 0) + 1);
}

export function hasInjectedTenantColumnHolder(entity: ClazzType<any>): boolean {
  return (holders.get(entity) ?? 0) > 0;
}

/** Drops one hold; removes the column when it was the last. */
export function releaseInjectedTenantColumn(
  entity: ClazzType<any>,
  metadataColumns: ColumnMetadata[] | undefined,
): void {
  const next = (holders.get(entity) ?? 0) - 1;
  if (next > 0) {
    holders.set(entity, next);
    return;
  }
  holders.delete(entity);
  stripInjectedTenantColumn(entity, metadataColumns);
}

/** Removes the marked column from the scanner metadata and the class metadata. */
export function stripInjectedTenantColumn(
  entity: ClazzType<any>,
  metadataColumns: ColumnMetadata[] | undefined,
): void {
  const strip = (columns: ColumnMetadata[] | undefined) => {
    if (!columns) return;
    for (let i = columns.length - 1; i >= 0; i--) {
      if (isInjectedTenantColumn(columns[i])) columns.splice(i, 1);
    }
  };
  strip(metadataColumns);
  strip(
    Reflect.getOwnMetadata(COLUMN_TOKEN, entity.prototype) as
      | ColumnMetadata[]
      | undefined,
  );
}
