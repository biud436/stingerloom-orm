/* eslint-disable @typescript-eslint/no-explicit-any */

interface CacheEntry<T = any> {
  data: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000; // 30 seconds

/**
 * TTL-based in-memory query cache.
 *
 * Cache key is built from: entity name + JSON-serialized where/order/limit/offset.
 * Entries are automatically evicted when their TTL expires.
 */
export class QueryCache {
  private readonly store = new Map<string, CacheEntry>();

  /**
   * Builds a deterministic cache key from the entity name and query options.
   */
  static buildKey(
    entityName: string,
    options: {
      where?: Record<string, any>;
      orderBy?: Record<string, any>;
      limit?: any;
      take?: any;
      select?: any;
      groupBy?: any;
    },
  ): string {
    const parts: Record<string, any> = { entity: entityName };

    if (options.where) parts.where = options.where;
    if (options.orderBy) parts.orderBy = options.orderBy;
    if (options.limit !== undefined) parts.limit = options.limit;
    if (options.take !== undefined) parts.take = options.take;
    if (options.select) parts.select = options.select;
    if (options.groupBy) parts.groupBy = options.groupBy;

    return JSON.stringify(parts);
  }

  /**
   * Returns a cached value if it exists and has not expired.
   */
  get<T = any>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.data as T;
  }

  /**
   * Stores a value with the given TTL (in milliseconds).
   */
  set<T = any>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS): void {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Invalidates all cache entries for a given entity name.
   */
  invalidate(entityName: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.includes(`"entity":"${entityName}"`)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clears the entire cache.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Returns the number of entries currently in the cache (including expired).
   */
  get size(): number {
    return this.store.size;
  }
}
