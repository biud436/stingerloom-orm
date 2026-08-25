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
    const store: MetadataContextStore = { tenantId, unscoped: false };
    return this.storage.run(store, callback);
  }

  /**
   * Runs the callback in an **unscoped** mode — the `"tenant_column"` strategy
   * will skip its automatic `WHERE tenant_id = ?` injection, letting the query
   * see rows from every tenant.
   *
   * Use this for administrative tasks: cross-tenant dashboards, background jobs
   * that must touch every tenant, migrations. Regular request handlers should
   * **never** call this.
   *
   * INSERT is still scoped to the surrounding `MetadataContext.run()` tenant,
   * if any. `runUnscoped()` called outside any `run()` block will reject
   * INSERTs on tenant-scoped entities because there is no tenant to populate.
   */
  static runUnscoped<T>(callback: () => T | Promise<T>): T | Promise<T> {
    const current = this.storage.getStore();
    const store: MetadataContextStore = {
      tenantId: current?.tenantId ?? "public",
      unscoped: true,
    };
    return this.storage.run(store, callback);
  }

  /**
   * Whether the current context is in unscoped mode.
   * The `"tenant_column"` strategy uses this to decide whether to skip
   * predicate injection.
   */
  static isUnscoped(): boolean {
    return this.storage.getStore()?.unscoped === true;
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
   * Captures the current context (tenant + unscoped flag), or null when no
   * context is active. Pair with {@link runCaptured} to replay it later:
   * deferred work — a lazy relation load fired by a property access — must
   * run under the context that hydrated the entity, not whatever context
   * happens to be active at access time (which may be another tenant's).
   */
  static capture(): MetadataContextStore | null {
    const store = this.storage.getStore();
    return store ? { ...store } : null;
  }

  /**
   * Runs the callback under a previously {@link capture}d context snapshot.
   * A null snapshot (captured outside any context) runs the callback in the
   * ambient context unchanged.
   */
  static runCaptured<T>(
    snapshot: MetadataContextStore | null,
    callback: () => T | Promise<T>,
  ): T | Promise<T> {
    if (snapshot === null) return callback();
    return this.storage.run({ ...snapshot }, callback);
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
  /**
   * When true, tenant-scoped SELECT/UPDATE/DELETE skip the `WHERE tenant_id`
   * filter injected by the `"tenant_column"` strategy. INSERTs are unaffected.
   */
  unscoped?: boolean;
}
