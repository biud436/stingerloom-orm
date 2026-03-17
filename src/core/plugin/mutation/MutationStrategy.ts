/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Strategy interface for snapshotting and diffing entity state.
 */
export interface MutationStrategy {
  /**
   * Create a deep clone of the entity's column values.
   */
  snapshot(instance: any, columnNames: string[]): Record<string, any>;

  /**
   * Compare the current entity state against a snapshot.
   * Returns an object of changed columns, or null if nothing changed.
   */
  diff(
    instance: any,
    snapshot: Record<string, any>,
    columnNames: string[],
    pkColumns: string[],
  ): Record<string, any> | null;
}

/**
 * Deep clone a single value.
 * Uses structuredClone when available, falls back to shallow copy for objects.
 */
export function cloneValue(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());

  try {
    return structuredClone(value);
  } catch {
    if (Array.isArray(value)) return [...value];
    return { ...value };
  }
}

/**
 * Deep equality check for entity column values.
 */
export function deepEquals(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEquals(v, b[i]));
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  return keysA.every((key) => deepEquals(a[key], b[key]));
}

/**
 * Snapshot-based mutation strategy.
 * Takes a deep clone at track() time and diffs against the live instance at flush() time.
 */
export class SnapshotStrategy implements MutationStrategy {
  snapshot(instance: any, columnNames: string[]): Record<string, any> {
    const snap: Record<string, any> = {};
    for (const col of columnNames) {
      snap[col] = cloneValue(instance[col]);
    }
    return snap;
  }

  diff(
    instance: any,
    snapshot: Record<string, any>,
    columnNames: string[],
    pkColumns: string[],
  ): Record<string, any> | null {
    const changes: Record<string, any> = {};
    let hasChanges = false;

    for (const col of columnNames) {
      // Skip PK columns — they identify the row, not a mutation
      if (pkColumns.includes(col)) continue;

      if (!deepEquals(instance[col], snapshot[col])) {
        changes[col] = instance[col];
        hasChanges = true;
      }
    }

    return hasChanges ? changes : null;
  }
}
