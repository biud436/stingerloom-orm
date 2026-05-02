/* eslint-disable @typescript-eslint/no-explicit-any */
import { MetadataLayer } from "./MetadataLayer";
import { MetadataContext } from "./MetadataContext";
import { MetadataPath } from "./MetadataPath";

/**
 * Hierarchical metadata store (Docker OverlayFS style).
 *
 * Lower layer (read-only): base schema (e.g. "public").
 * Upper layers (read/write): per-tenant modifications (e.g. "tenant_1", "tenant_2").
 *
 * Reads: search the current context layer, then fall back to public; other
 * tenant layers are never consulted.
 * Writes: Copy-on-Write — only the top-most work layer is modified.
 *
 * @deprecated This class is **not wired into the decorator pipeline**.
 * Decorators (`@Entity`, `@Column`, …) write to `MetadataLayerRegistry`
 * (`src/scanner/MetadataScanner.ts`), which is the canonical source of truth
 * for the EntityManager. Mutations made to a `LayeredMetadataStore` instance
 * are never observed by the runtime. Prefer `MetadataLayerRegistry.getInstance()`
 * together with `MetadataContext.run(tenantId, callback)`. This class is kept
 * for backward-compat tests only and may be removed in a future release.
 * See issue #277.
 */
export class LayeredMetadataStore {
  private layers: MetadataLayer[] = [];
  private pathTrie: MetadataPath;
  private currentContext: string = "public"; // default context

  constructor() {
    this.pathTrie = new MetadataPath();
    // Create the default lower layer
    this.addLayer("public", true);
  }

  /**
   * Add a new layer.
   * @param name layer name
   * @param isReadOnly whether the layer is read-only
   */
  addLayer(name: string, isReadOnly = false): MetadataLayer {
    const existingLayer = this.layers.find((l) => l.getName() === name);
    if (existingLayer) {
      throw new Error(`Layer "${name}" already exists.`);
    }

    const layer = new MetadataLayer(name, isReadOnly);
    this.layers.push(layer);
    return layer;
  }

  /**
   * Get a layer by name.
   */
  getLayer(name: string): MetadataLayer | undefined {
    return this.layers.find((l) => l.getName() === name);
  }

  /**
   * Set the current context (e.g. switch to "tenant_1").
   *
   * @deprecated In production code, prefer `MetadataContext.run(tenantId, callback)`.
   * `setContext()` mutates instance state and is not safe under concurrent requests.
   * Use only from test code.
   */
  setContext(context: string): void {
    this.currentContext = context;
  }

  /**
   * Return the currently active context.
   * Prefers the AsyncLocalStorage-based MetadataContext when active;
   * otherwise returns the instance's currentContext (for test compatibility).
   */
  getContext(): string {
    return this.resolveContext();
  }

  /**
   * Safely resolve the current context.
   * Priority: AsyncLocalStorage > instance state.
   */
  private resolveContext(): string {
    if (MetadataContext.isActive()) {
      return MetadataContext.getCurrentTenant();
    }
    return this.currentContext;
  }

  /**
   * Set metadata (writes to the current context's top-most writable layer).
   * Uses Copy-on-Write semantics.
   */
  set<T>(key: string, value: T): void {
    const context = this.resolveContext();
    const fullPath = `${context}/${key}`;

    // #148: allow direct writes to the public layer
    if (context === "public") {
      const publicLayer = this.getLayer("public");
      if (publicLayer) {
        publicLayer.getInternalMap().set(key, value);
        this.pathTrie.insert(fullPath, { layer: "public", key, value });
        return;
      }
    }

    // Find the writable layer for the current context
    let workLayer = this.layers.find(
      (l) => l.getName() === context && !l.isReadOnlyLayer(),
    );

    // Create a writable layer if none exists
    if (!workLayer) {
      workLayer = this.addLayer(context, false);
    }

    // Store into the layer
    workLayer.set(key, value);

    // Register the path in the trie
    this.pathTrie.insert(fullPath, { layer: workLayer.getName(), key, value });
  }

  /**
   * Read metadata from the merged view.
   * Searches the current context layer, then falls back to public;
   * other tenant layers are never consulted.
   */
  get<T>(key: string): T | undefined {
    const context = this.resolveContext();
    const fullPath = `${context}/${key}`;

    // 1. Look up the current context's path in the trie
    const pathData = this.pathTrie.search(fullPath);
    if (pathData) {
      return pathData.value;
    }

    // 2. Search only the current context layer (never other tenant layers)
    const contextLayer = this.getLayer(context);
    if (contextLayer) {
      const value = contextLayer.get<T>(key);
      if (value !== undefined) {
        return value;
      }
    }

    // 3. Fall back to the public (lower) layer
    if (context !== "public") {
      const publicPath = `public/${key}`;
      const publicData = this.pathTrie.search(publicPath);
      if (publicData) {
        return publicData.value;
      }

      const publicLayer = this.getLayer("public");
      if (publicLayer) {
        return publicLayer.get<T>(key);
      }
    }

    return undefined;
  }

  /**
   * Check whether metadata exists.
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Fetch every metadata entry in a given context as a merged view.
   * OverlayFS style: merge the public (lower) layer with the target context (upper) layer only.
   */
  getAllInContext<T>(context?: string): Map<string, T> {
    const targetContext = context || this.resolveContext();
    const result = new Map<string, T>();

    // 1. Collect entries from the public (lower) layer as the base
    const publicLayer = this.getLayer("public");
    if (publicLayer) {
      for (const [key, value] of publicLayer.entries<T>()) {
        result.set(key, value);
      }
    }

    // 2. Overlay the target context layer's entries (Copy-on-Write)
    if (targetContext !== "public") {
      const contextLayer = this.getLayer(targetContext);
      if (contextLayer) {
        for (const [key, value] of contextLayer.entries<T>()) {
          result.set(key, value);
        }
      }
    }

    return result;
  }

  /**
   * Copy a layer (used when creating a new tenant in a multi-tenant setup).
   * @param sourceName source layer name
   * @param targetName target layer name
   */
  copyLayer(sourceName: string, targetName: string): MetadataLayer {
    const sourceLayer = this.getLayer(sourceName);
    if (!sourceLayer) {
      throw new Error(`Source layer "${sourceName}" not found.`);
    }

    // #141: prevent duplicate target layer names
    const existingLayer = this.getLayer(targetName);
    if (existingLayer) {
      throw new Error(`Layer "${targetName}" already exists.`);
    }

    const clonedLayer = sourceLayer.clone(targetName, false);
    this.layers.push(clonedLayer);

    // Copy the paths into the trie as well
    const sourcePaths = this.pathTrie.findByPrefix(sourceName);
    for (const { path, value } of sourcePaths) {
      const newPath = path.replace(sourceName, targetName);
      this.pathTrie.insert(newPath, { ...value, layer: targetName });
    }

    return clonedLayer;
  }

  /**
   * Merge a layer (promote a tenant's changes into public).
   */
  mergeLayer(sourceName: string, targetName: string): void {
    const sourceLayer = this.getLayer(sourceName);
    const targetLayer = this.getLayer(targetName);

    if (!sourceLayer) {
      throw new Error(`Source layer "${sourceName}" not found.`);
    }
    if (!targetLayer) {
      throw new Error(`Target layer "${targetName}" not found.`);
    }

    // #148: allow merging into the public layer (via getInternalMap)
    const isTargetReadOnly = targetLayer.isReadOnlyLayer();

    // Copy all source-layer data into the target layer and sync the trie (#143)
    for (const [key, value] of sourceLayer.entries()) {
      if (isTargetReadOnly) {
        targetLayer.getInternalMap().set(key, value);
      } else {
        targetLayer.set(key, value);
      }
      const fullPath = `${targetName}/${key}`;
      this.pathTrie.insert(fullPath, { layer: targetName, key, value });
    }
  }

  /**
   * Clear layer data and sync the trie (#143).
   */
  clearLayer(name: string): void {
    const layer = this.getLayer(name);
    if (!layer) {
      throw new Error(`Layer "${name}" not found.`);
    }
    layer.clear();
    // Remove the layer's paths from the trie as well
    const paths = this.pathTrie.findByPrefix(name);
    for (const { path } of paths) {
      this.pathTrie.delete(path);
    }
  }

  /**
   * Remove a layer.
   */
  removeLayer(name: string): boolean {
    const index = this.layers.findIndex((l) => l.getName() === name);
    if (index === -1) {
      return false;
    }

    // The public layer cannot be removed
    if (name === "public") {
      throw new Error('Cannot remove "public" layer.');
    }

    this.layers.splice(index, 1);

    // Remove the paths from the trie as well
    const paths = this.pathTrie.findByPrefix(name);
    for (const { path } of paths) {
      this.pathTrie.delete(path);
    }

    return true;
  }

  /**
   * Return info for every layer.
   */
  getLayersInfo() {
    return this.layers.map((layer) => layer.getLayerInfo());
  }

  /**
   * Search for all entries under a given path prefix.
   */
  findByPrefix(prefix: string): Array<{ path: string; value: any }> {
    return this.pathTrie.findByPrefix(`${this.resolveContext()}/${prefix}`);
  }
}
