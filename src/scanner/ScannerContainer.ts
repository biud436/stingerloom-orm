/**
 * Lightweight singleton registry replacing typedi's Container.
 * All scanners are stateless singletons — they only need a single
 * instance per process. This avoids pulling in the entire DI framework.
 */
const instances = new Map<Function, unknown>();

export function getScannerInstance<T>(cls: new () => T): T {
  let instance = instances.get(cls) as T | undefined;
  if (!instance) {
    instance = new cls();
    instances.set(cls, instance);
  }
  return instance;
}

/**
 * Clears all cached scanner instances.
 * Primarily used in tests to reset state between test runs.
 */
export function resetScannerContainer(): void {
  instances.clear();
}
