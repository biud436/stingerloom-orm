import { AsyncLocalStorage } from "async_hooks";

/**
 * Request-scoped metadata context.
 *
 * Uses AsyncLocalStorage to preserve an independent tenantId per request
 * (or per asynchronous execution unit).
 *
 * The context can be configured via NestJS middleware, Express middleware,
 * or explicit manual calls.
 *
 * @example
 * ```ts
 * // Automatic setup in middleware
 * MetadataContext.run("tenant_1", async () => {
 *   // All metadata lookups inside this block run under the tenant_1 context
 *   await entityManager.find(User, { where: { id: 1 } });
 * });
 *
 * // Look up the current context (returns "public" if none)
 * const tenant = MetadataContext.getCurrentTenant();
 * ```
 */
export class MetadataContext {
  private static storage = new AsyncLocalStorage<MetadataContextStore>();

  /**
   * Runs the callback under the given tenantId context.
   * The same tenantId is preserved across all async calls made inside the callback.
   *
   * @param tenantId tenant identifier (e.g. "tenant_1")
   * @param callback async work to execute
   * @returns the callback's return value
   */
  static run<T>(
    tenantId: string,
    callback: () => T | Promise<T>,
  ): T | Promise<T> {
    const store: MetadataContextStore = { tenantId };
    return this.storage.run(store, callback);
  }

  /**
   * Returns the tenantId of the current async context.
   * Returns "public" if no AsyncLocalStorage context is active.
   */
  static getCurrentTenant(): string {
    const store = this.storage.getStore();
    return store?.tenantId ?? "public";
  }

  /**
   * Whether the AsyncLocalStorage context is active.
   */
  static isActive(): boolean {
    const store = this.storage.getStore();
    const isActive = store !== undefined;
    return isActive;
  }

  /**
   * Recreates the internal storage (used in tests, etc.).
   */
  static reset(): void {
    this.storage = new AsyncLocalStorage<MetadataContextStore>();
  }
}

/**
 * Context data stored in AsyncLocalStorage.
 */
export interface MetadataContextStore {
  tenantId: string;
}
