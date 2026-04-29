/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { MetadataLayer } from "../metadata/MetadataLayer";
import { MetadataContext } from "../metadata/MetadataContext";

/**
 * Global LayeredMetadataStore registry.
 *
 * A central layer manager shared by all MetadataScanner instances.
 * Writes go to the "public" layer by default; context switching supports multi-tenancy.
 *
 * When the AsyncLocalStorage-based MetadataContext is active,
 * the request-scoped tenantId takes precedence.
 */
export class MetadataLayerRegistry {
  private static instance: MetadataLayerRegistry;

  private layers: Map<string, MetadataLayer> = new Map();
  private currentContext: string = "public";

  // resolveAll() cache (#80) — bounded to prevent memory leak in multi-tenant
  private static readonly MAX_CACHE_SIZE = 1000;
  private resolveAllCache: Map<string, Map<string, any>> = new Map();
  private dirtyContexts: Set<string> = new Set(["public"]);

  private constructor() {
    // Default lower layer (writable — decorators need to record metadata into it)
    this.layers.set("public", new MetadataLayer("public", false));
  }

  static getInstance(): MetadataLayerRegistry {
    if (!MetadataLayerRegistry.instance) {
      MetadataLayerRegistry.instance = new MetadataLayerRegistry();
    }
    return MetadataLayerRegistry.instance;
  }

  /**
   * Reset global state (used in tests, etc.)
   */
  static reset(): void {
    MetadataLayerRegistry.instance = new MetadataLayerRegistry();
  }

  // ── Context ──────────────────────────────────────────────

  /**
   * Returns the current context.
   *
   * Priority:
   * 1. tenantId from AsyncLocalStorage (MetadataContext), if active
   * 2. The value set manually via setContext()
   * 3. Default "public"
   */
  getContext(): string {
    if (MetadataContext.isActive()) {
      return MetadataContext.getCurrentTenant();
    }
    return this.currentContext;
  }

  setContext(context: string): void {
    this.currentContext = context;
    // Automatically create the layer if it does not exist
    if (!this.layers.has(context)) {
      this.layers.set(context, new MetadataLayer(context, false));
      this.dirtyContexts.add(context);
    }
  }

  // ── Layer management ─────────────────────────────────────

  getLayer(name: string): MetadataLayer | undefined {
    return this.layers.get(name);
  }

  getCurrentLayer(): MetadataLayer {
    const ctx = this.getContext();
    let layer = this.layers.get(ctx);
    if (!layer) {
      layer = new MetadataLayer(ctx, false);
      this.layers.set(ctx, layer);
    }
    return layer;
  }

  /**
   * The shared "public" layer. Always exists (created in the constructor).
   *
   * Decorator-time metadata is class-definition-time data and must always
   * live here regardless of any active MetadataContext.run() tenant — see
   * MetadataScanner.setOnPublic and issue #280.
   */
  getPublicLayer(): MetadataLayer {
    return this.layers.get("public")!;
  }

  addLayer(name: string, readOnly = false): MetadataLayer {
    if (this.layers.has(name)) {
      throw new Error(`Layer "${name}" already exists.`);
    }
    const layer = new MetadataLayer(name, readOnly);
    this.layers.set(name, layer);
    return layer;
  }

  /**
   * Copy a layer (multi-tenant — a new tenant clones the public schema).
   */
  copyLayer(sourceName: string, targetName: string): MetadataLayer {
    const source = this.layers.get(sourceName);
    if (!source) throw new Error(`Source layer "${sourceName}" not found.`);
    const cloned = source.clone(targetName, false);
    this.layers.set(targetName, cloned);
    this.dirtyContexts.add(targetName);
    return cloned;
  }

  /**
   * Remove a layer.
   */
  removeLayer(name: string): boolean {
    if (name === "public") throw new Error('Cannot remove "public" layer.');
    this.resolveAllCache.delete(name);
    this.dirtyContexts.delete(name);
    return this.layers.delete(name);
  }

  /**
   * Info for all layers.
   */
  getLayersInfo() {
    return Array.from(this.layers.values()).map((l) => l.getLayerInfo());
  }

  /**
   * Reads a value from the merged view.
   * Searches the current context layer, then falls back to public (OverlayFS-style).
   */
  resolveValue<T>(key: string): T | undefined {
    const ctx = this.getContext();
    // 1. Current context layer
    const contextLayer = this.layers.get(ctx);
    if (contextLayer) {
      const v = contextLayer.get<T>(key);
      if (v !== undefined) return v;
    }
    // 2. public fallback (only when the current context is not "public")
    if (ctx !== "public") {
      const publicLayer = this.layers.get("public");
      if (publicLayer) {
        const v = publicLayer.get<T>(key);
        if (v !== undefined) return v;
      }
    }
    return undefined;
  }

  /**
   * Returns every entry from the merged view (lower → upper, with upper overriding).
   * The result is cached based on a dirty flag (#80).
   */
  resolveAll<T>(): Map<string, T> {
    const ctx = this.getContext();

    // Cache hit: return the cached result when the context is not dirty
    if (!this.dirtyContexts.has(ctx)) {
      const cached = this.resolveAllCache.get(ctx);
      if (cached) return cached as Map<string, T>;
    }

    const result = new Map<string, T>();

    // 1. public layer (lower)
    const publicLayer = this.layers.get("public");
    if (publicLayer) {
      for (const [k, v] of publicLayer.entries<T>()) {
        result.set(k, v);
      }
    }

    // 2. Current context layer (upper) — overrides
    if (ctx !== "public") {
      const contextLayer = this.layers.get(ctx);
      if (contextLayer) {
        for (const [k, v] of contextLayer.entries<T>()) {
          result.set(k, v);
        }
      }
    }

    // Evict oldest entries if cache exceeds max size
    if (this.resolveAllCache.size >= MetadataLayerRegistry.MAX_CACHE_SIZE) {
      const firstKey = this.resolveAllCache.keys().next().value;
      if (firstKey !== undefined && firstKey !== "public") {
        this.resolveAllCache.delete(firstKey);
      }
    }

    this.resolveAllCache.set(ctx, result);
    this.dirtyContexts.delete(ctx);

    return result;
  }

  /**
   * Invalidates the resolveAll cache for the given context.
   * When "public" is dirtied, every context cache is invalidated.
   */
  markDirty(context: string): void {
    if (context === "public") {
      this.resolveAllCache.clear();
      for (const key of this.layers.keys()) {
        this.dirtyContexts.add(key);
      }
    } else {
      this.dirtyContexts.add(context);
    }
  }
}

/**
 * Base class for metadata scanners
 *
 * Internally stores metadata in the current layer of MetadataLayerRegistry.
 * Preserves the existing API (set/get/clear/allMetadata/has/size), so
 * existing subclasses such as ColumnScanner, EntityScanner, ManyToOneScanner,
 * and decorator code continue to work unchanged.
 *
 * Each scanner instance has its own namespace via scannerPrefix, so multiple
 * scanners can coexist in the same layer without interfering with each other.
 */
export class MetadataScanner {
  /**
   * @deprecated Kept for subclasses that iterate `mapper` directly.
   * Scheduled for removal after the layer-system migration is complete.
   * Returns only the entries under this scanner's prefix in the current context layer.
   */
  protected get mapper(): Map<string, any> {
    return this.prefixedView;
  }

  private uniqueIdCounter = 0;

  /**
   * Prefix identifying this scanner.
   * Subclasses set it via super("columns"), etc.
   * Defaults to "" (global namespace) when omitted.
   */
  protected readonly scannerPrefix: string;

  constructor(scannerPrefix = "") {
    this.scannerPrefix = scannerPrefix;
  }

  // ── LayerRegistry access ────────────────────────────────

  protected get registry(): MetadataLayerRegistry {
    return MetadataLayerRegistry.getInstance();
  }

  /**
   * Applies the prefix to an internal key.
   */
  private prefixKey(key: string): string {
    return this.scannerPrefix ? `${this.scannerPrefix}::${key}` : key;
  }

  /**
   * Restores the original key from a prefixed key.
   */
  private unprefixKey(key: string): string {
    if (!this.scannerPrefix) return key;
    const prefix = `${this.scannerPrefix}::`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  /**
   * Returns a Map view over the current context layer scoped to this scanner's namespace.
   * Supports the `for (const [_, value] of this.mapper)` pattern used by subclasses.
   */
  private get prefixedView(): Map<string, any> {
    const layer = this.registry.getCurrentLayer();
    const raw = layer.getInternalMap();

    if (!this.scannerPrefix) return raw;

    const view = new Map<string, any>();
    const prefix = `${this.scannerPrefix}::`;
    for (const [k, v] of raw) {
      if (k.startsWith(prefix)) {
        view.set(k.slice(prefix.length), v);
      }
    }
    return view;
  }

  // ── Existing API (backward compatibility) ────────────────

  /**
   * Create a unique key for metadata storage
   */
  public createUniqueKey(): string {
    return `key_${Date.now()}_${this.uniqueIdCounter++}`;
  }

  /**
   * Store metadata with a key
   * Stored in the layer of the current context.
   */
  public set<T>(key: string, value: T): void {
    this.registry.getCurrentLayer().set(this.prefixKey(key), value);
    this.registry.markDirty(this.registry.getContext());
  }

  /**
   * Store metadata on the shared "public" layer regardless of the active
   * MetadataContext.
   *
   * Decorator-time metadata (`@Entity`, `@Column`, `@ManyToOne`, ...) is
   * class-definition-time data and must always live on `"public"` so it is
   * visible to every tenant. If a class is decorated inside
   * `MetadataContext.run("acme", ...)` — e.g. from `IntrospectionGenerator`
   * or a runtime entity factory invoked under a request handler — a plain
   * `set()` would silently route the metadata to the `"acme"` layer, leaving
   * other tenants unable to load the entity. See issue #280.
   *
   * Tenant-specific overrides (Copy-on-Write deltas) should continue to use
   * `set()` while the tenant context is active.
   */
  public setOnPublic<T>(key: string, value: T): void {
    this.registry.getPublicLayer().set(this.prefixKey(key), value);
    this.registry.markDirty("public");
  }

  /**
   * Retrieve metadata by key (merged view)
   */
  public get<T>(key: string): T | undefined {
    return this.registry.resolveValue<T>(this.prefixKey(key));
  }

  /**
   * Clear metadata for this scanner's namespace in current context layer.
   * Does not affect data owned by other scanners.
   */
  public clear(): void {
    const layer = this.registry.getCurrentLayer();
    if (!this.scannerPrefix) {
      layer.clear();
      this.registry.markDirty(this.registry.getContext());
      return;
    }
    const prefix = `${this.scannerPrefix}::`;
    const raw = layer.getInternalMap();
    const keysToDelete: string[] = [];
    for (const key of raw.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    if (keysToDelete.length > 0) {
      for (const key of keysToDelete) {
        raw.delete(key);
      }
      this.registry.markDirty(this.registry.getContext());
    }
  }

  /**
   * Get all metadata values for this scanner's namespace (merged view)
   */
  public allMetadata<T = any>(): T[] {
    const merged = this.registry.resolveAll<T>();
    if (!this.scannerPrefix) {
      return Array.from(merged.values());
    }
    const prefix = `${this.scannerPrefix}::`;
    const results: T[] = [];
    for (const [key, value] of merged) {
      if (key.startsWith(prefix)) {
        results.push(value);
      }
    }
    return results;
  }

  /**
   * Check if a key exists (merged view)
   */
  public has(key: string): boolean {
    return this.registry.resolveValue(this.prefixKey(key)) !== undefined;
  }

  /**
   * Get the size of the metadata store for this namespace (merged view)
   */
  public get size(): number {
    return this.allMetadata().length;
  }

  // ── O(1) Target Lookup (#77) ────────────────────────────

  private lastResolvedMap: Map<string, any> | null = null;
  private targetIndexMap: Map<Function, any[]> = new Map();

  /**
   * O(1) lookup by entity class (target).
   * Returns all metadata entries in this scanner's namespace whose `target` matches.
   * The index is lazily rebuilt when the underlying resolveAll() map changes.
   */
  public getByTarget<T extends { target: Function }>(target: Function): T[] {
    const merged = this.registry.resolveAll<T>();
    if (merged !== this.lastResolvedMap) {
      this.targetIndexMap.clear();
      const prefix = this.scannerPrefix ? `${this.scannerPrefix}::` : "";
      for (const [key, value] of merged) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (value && typeof value === "object" && "target" in value) {
          const fn = (value as any).target as Function;
          const existing = this.targetIndexMap.get(fn);
          if (existing) {
            existing.push(value);
          } else {
            this.targetIndexMap.set(fn, [value]);
          }
        }
      }
      this.lastResolvedMap = merged;
    }
    return (this.targetIndexMap.get(target) ?? []) as T[];
  }

  // ── Multi-tenant support API ────────────────────────────

  /**
   * Switch the current context.
   */
  public switchContext(context: string): void {
    this.registry.setContext(context);
  }

  /**
   * Return the current context.
   */
  public getContext(): string {
    return this.registry.getContext();
  }

  /**
   * Copy a layer (create a new tenant).
   */
  public copyLayer(source: string, target: string): void {
    this.registry.copyLayer(source, target);
  }
}
