/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Proxy-based lazy loading utility.
 *
 * For ManyToOne fields configured with `lazy: true`, defers the DB query
 * until the actual property is accessed.
 *
 * Uses an ES Proxy internally to intercept property access and calls
 * `loadFn` on the first access to load the related entity.
 */

export type LazyLoadFn<T> = () => Promise<T | undefined>;

const LAZY_MARKER = Symbol.for("STG_LAZY_PROXY");

/**
 * Creates a lazy-loading proxy.
 *
 * @param loadFn async function that loads the related entity
 * @returns proxy object that loads the entity on property access
 */
export function createLazyProxy<T extends object>(loadFn: LazyLoadFn<T>): T {
  let loaded = false;
  let cachedValue: T | undefined;
  let loadPromise: Promise<T | undefined> | null = null;

  const handler: ProxyHandler<object> = {
    get(_target, prop, receiver) {
      // Identify the lazy proxy by its marker symbol
      if (prop === LAZY_MARKER) {
        return true;
      }

      // Do not trap then/catch access so the proxy is not treated as thenable under await
      if (prop === "then" || prop === "catch" || prop === "finally") {
        return undefined;
      }

      // If already loaded, return from the cached value
      if (loaded) {
        if (cachedValue == null) return undefined;
        return Reflect.get(cachedValue as object, prop, receiver);
      }

      // If loading is in flight, chain the existing promise
      if (!loadPromise) {
        loadPromise = loadFn().then((result) => {
          loaded = true;
          cachedValue = result;
          loadPromise = null;
          return result;
        });
      }

      // Synchronous access returns undefined before the async load completes.
      // For async usage, call load() and then access the property.
      return undefined;
    },

    has(_target, prop) {
      if (prop === LAZY_MARKER) return true;
      if (loaded) {
        if (cachedValue == null) return false;
        return prop in (cachedValue as object);
      }
      return false;
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy({} as any, handler) as T;
}

/**
 * Load a lazy proxy and return the resolved entity.
 *
 * @param proxy proxy object created by createLazyProxy
 * @param loadFn async function that loads the related entity
 * @returns the loaded related entity
 */
export async function loadLazy<T extends object>(
  loadFn: LazyLoadFn<T>,
): Promise<T | undefined> {
  return loadFn();
}

/**
 * Returns true when the given object is a LazyLoader proxy.
 */
export function isLazyProxy(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false;
  if (typeof obj !== "object") return false;
  try {
    return (obj as any)[LAZY_MARKER] === true;
  } catch {
    return false;
  }
}

/**
 * Inject a lazy proxy onto a specific property of an entity.
 *
 * @param entity target entity instance
 * @param propertyName property name to receive the lazy proxy
 * @param loadFn async function that loads the related entity
 */
export function injectLazyProxy<T extends object, R extends object>(
  entity: T,
  propertyName: string,
  loadFn: LazyLoadFn<R>,
): void {
  let loaded = false;
  let cachedValue: R | undefined;

  Object.defineProperty(entity, propertyName, {
    configurable: true,
    enumerable: true,
    get(): R | Promise<R | undefined> | undefined {
      if (loaded) {
        return cachedValue;
      }
      // Load asynchronously and cache
      const promise = loadFn().then((result) => {
        loaded = true;
        cachedValue = result;
        // Replace the getter with the resolved value
        Object.defineProperty(entity, propertyName, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: result,
        });
        return result;
      });
      return promise;
    },
    set(value: R) {
      loaded = true;
      cachedValue = value;
      // Switch to a plain property once the setter is invoked
      Object.defineProperty(entity, propertyName, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    },
  });
}
