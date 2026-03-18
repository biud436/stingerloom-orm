/* eslint-disable @typescript-eslint/no-explicit-any */

const PERSISTENT_MARKER = Symbol.for("STG_PERSISTENT_COLLECTION");

/**
 * Mutating array methods that should trigger the onChange callback.
 */
const MUTATING_METHODS = new Set([
  "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin",
]);

/**
 * Wraps an array with a Proxy that calls `onChange` whenever the array is mutated.
 *
 * Intercepts:
 * - Index assignment: `arr[0] = x`
 * - Length changes: `arr.length = 0`
 * - Mutating methods: push, pop, shift, unshift, splice, sort, reverse, fill, copyWithin
 *
 * The returned array is fully compatible with `Array.isArray()` and spread/destructuring.
 */
export function createPersistentCollection<T>(
  items: T[],
  onChange: () => void,
): T[] {
  const handler: ProxyHandler<T[]> = {
    set(target, prop, value, receiver) {
      const result = Reflect.set(target, prop, value, receiver);
      // Numeric index or "length" → array mutation
      if (typeof prop === "string" && (!isNaN(Number(prop)) || prop === "length")) {
        onChange();
      }
      return result;
    },

    deleteProperty(target, prop) {
      const result = Reflect.deleteProperty(target, prop);
      onChange();
      return result;
    },

    get(target, prop, receiver) {
      if (prop === PERSISTENT_MARKER) return true;

      const value = Reflect.get(target, prop, receiver);
      // Wrap mutating methods
      if (typeof prop === "string" && MUTATING_METHODS.has(prop) && typeof value === "function") {
        return function (this: any, ...args: any[]) {
          const result = value.apply(target, args);
          onChange();
          return result;
        };
      }
      return value;
    },
  };

  return new Proxy(items, handler);
}

/**
 * Check if an array is a PersistentCollection proxy.
 */
export function isPersistentCollection(arr: unknown): boolean {
  if (!Array.isArray(arr)) return false;
  try {
    return (arr as any)[PERSISTENT_MARKER] === true;
  } catch {
    return false;
  }
}
