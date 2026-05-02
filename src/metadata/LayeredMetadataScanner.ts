/* eslint-disable @typescript-eslint/no-explicit-any */
import { LayeredMetadataStore } from "./LayeredMetadataStore";
import { ClazzType } from "../utils";

/**
 * Adapter that bridges the legacy MetadataScanner API with the layered store.
 *
 * Designed to preserve backward compatibility so existing code can migrate incrementally.
 *
 * @deprecated Wraps {@link LayeredMetadataStore}, which is **not** the
 * decorator-time registry. The canonical scanner base class is
 * `MetadataScanner` in `src/scanner/MetadataScanner.ts`, which reads from
 * `MetadataLayerRegistry`. New code should not extend or instantiate this
 * class. See issue #277.
 */
export class LayeredMetadataScanner {
  protected store: LayeredMetadataStore;
  protected prefix: string; // Per-scanner prefix (e.g. "entities", "columns").

  constructor(store: LayeredMetadataStore, prefix: string) {
    this.store = store;
    this.prefix = prefix;
  }

  /**
   * Generate a unique key (legacy API compatibility).
   */
  public createUniqueKey(): string {
    return `${this.prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Store metadata in the current context's layer.
   */
  public set<T>(key: string, value: T): void {
    const fullKey = `${this.prefix}/${key}`;
    this.store.set(fullKey, value);
  }

  /**
   * Read metadata from the merged view.
   */
  public get<T>(key: string): T | undefined {
    const fullKey = `${this.prefix}/${key}`;
    return this.store.get<T>(fullKey);
  }

  /**
   * Return every metadata entry merged for the current context.
   */
  public allMetadata<T = any>(): T[] {
    const allData = this.store.getAllInContext<T>();
    const results: T[] = [];

    for (const [key, value] of allData.entries()) {
      // Keep only keys starting with the scanner prefix
      if (key.startsWith(this.prefix)) {
        results.push(value);
      }
    }

    return results;
  }

  /**
   * Check whether a key exists.
   */
  public has(key: string): boolean {
    const fullKey = `${this.prefix}/${key}`;
    return this.store.has(fullKey);
  }

  /**
   * Clear the current context's metadata.
   */
  public clear(): void {
    const context = this.store.getContext();
    const layer = this.store.getLayer(context);

    if (!layer) {
      return;
    }

    // Delete only the keys belonging to the current prefix
    const keysToDelete: string[] = [];
    for (const key of layer.keys()) {
      if (key.startsWith(this.prefix)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      layer.delete(key);
    }
  }

  /**
   * Return the metadata size.
   */
  public get size(): number {
    return this.allMetadata().length;
  }

  /**
   * Switch the current context (multi-tenant support).
   */
  public switchContext(context: string): void {
    this.store.setContext(context);
  }

  /**
   * Get the current context.
   */
  public getCurrentContext(): string {
    return this.store.getContext();
  }

  /**
   * Copy the current layer into a new layer (used when creating a new tenant).
   */
  public copyToNewContext(newContext: string): void {
    const currentContext = this.store.getContext();
    this.store.copyLayer(currentContext, newContext);
  }
}

/**
 * Layered scanner used by EntityScanner.
 *
 * @deprecated Not wired into the decorator pipeline. See {@link LayeredMetadataScanner}.
 */
export class LayeredEntityScanner extends LayeredMetadataScanner {
  constructor(store: LayeredMetadataStore) {
    super(store, "entities");
  }

  /**
   * Scan an entity (legacy API compatibility).
   */
  public scan(target: ClazzType<unknown>): any | null {
    const allEntities = this.allMetadata();

    for (const entity of allEntities) {
      if (entity.target === target) {
        return entity;
      }
    }

    return null;
  }

  /**
   * Iterate over every entity (legacy API compatibility).
   */
  public *makeEntities(): IterableIterator<any> {
    const entities = this.allMetadata();
    for (const entity of entities) {
      yield entity;
    }
  }
}

/**
 * Layered scanner used by ColumnScanner.
 *
 * @deprecated Not wired into the decorator pipeline. See {@link LayeredMetadataScanner}.
 */
export class LayeredColumnScanner extends LayeredMetadataScanner {
  constructor(store: LayeredMetadataStore) {
    super(store, "columns");
  }

  /**
   * Iterate over every column (legacy API compatibility).
   */
  public *makeColumns(): IterableIterator<any> {
    const columns = this.allMetadata();
    for (const column of columns) {
      yield column;
    }
  }
}

/**
 * Layered scanner used by ManyToOneScanner.
 *
 * @deprecated Not wired into the decorator pipeline. See {@link LayeredMetadataScanner}.
 */
export class LayeredManyToOneScanner extends LayeredMetadataScanner {
  constructor(store: LayeredMetadataStore) {
    super(store, "relations");
  }

  /**
   * Scan a relation (legacy API compatibility).
   */
  public scan(target: ClazzType<unknown>): any | null {
    const allRelations = this.allMetadata();

    for (const relation of allRelations) {
      if (relation.target === target) {
        return relation;
      }
    }

    return null;
  }

  /**
   * Iterate over every ManyToOne relation (legacy API compatibility).
   */
  public *makeManyToOnes(): IterableIterator<any> {
    const relations = this.allMetadata();
    for (const relation of relations) {
      yield relation;
    }
  }
}
