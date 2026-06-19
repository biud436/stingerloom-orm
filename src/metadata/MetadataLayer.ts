/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Metadata layer.
 * Similar to Docker layers: each layer stores independent metadata.
 */
export class MetadataLayer {
  /** @internal Exposed as protected so scanners can integrate with it. */
  protected metadata: Map<string, any> = new Map();
  private readonly name: string;
  private readonly isReadOnly: boolean;
  private readonly createdAt: Date;

  constructor(name: string, isReadOnly = false) {
    this.name = name;
    this.isReadOnly = isReadOnly;
    this.createdAt = new Date();
  }

  /**
   * Return the layer name.
   */
  getName(): string {
    return this.name;
  }

  /**
   * Whether the layer is read-only.
   */
  isReadOnlyLayer(): boolean {
    return this.isReadOnly;
  }

  /**
   * Set metadata.
   * Throws if the layer is read-only.
   */
  set<T>(key: string, value: T): void {
    if (this.isReadOnly) {
      throw new Error(
        `Cannot modify read-only layer: ${this.name}. Use a writable upper layer.`,
      );
    }
    this.metadata.set(key, value);
  }

  /**
   * Get metadata (only from the current layer).
   */
  get<T>(key: string): T | undefined {
    return this.metadata.get(key);
  }

  /**
   * Check whether a key exists.
   */
  has(key: string): boolean {
    return this.metadata.has(key);
  }

  /**
   * Delete metadata (throws on a read-only layer).
   */
  delete(key: string): boolean {
    if (this.isReadOnly) {
      throw new Error(
        `Cannot delete from read-only layer: ${this.name}. Use a whiteout marker.`,
      );
    }
    return this.metadata.delete(key);
  }

  /**
   * Return every key in the current layer.
   */
  keys(): string[] {
    return Array.from(this.metadata.keys());
  }

  /**
   * Return every value in the current layer.
   */
  values<T>(): T[] {
    return Array.from(this.metadata.values());
  }

  /**
   * Return every entry in the current layer.
   */
  entries<T>(): Array<[string, T]> {
    return Array.from(this.metadata.entries());
  }

  /**
   * Return the layer size.
   */
  size(): number {
    return this.metadata.size;
  }

  /**
   * Return the internal Map reference.
   * Used for integration with MetadataScanner.
   * @internal
   */
  getInternalMap(): Map<string, any> {
    return this.metadata;
  }

  /**
   * Return layer info.
   */
  getLayerInfo() {
    return {
      name: this.name,
      isReadOnly: this.isReadOnly,
      createdAt: this.createdAt,
      size: this.metadata.size,
    };
  }

  /**
   * Clone the current layer into a new, independent layer.
   *
   * This is the copy-on-write primitive of the layered (OverlayFS-style)
   * metadata model: a tenant overlay cloned from the public layer must not
   * share mutable state with it, or a later in-place mutation on one layer
   * (e.g. `meta.columns.push(...)`) would leak into the other and break
   * tenant isolation.
   *
   * `structuredClone` cannot be used because metadata holds class constructors
   * and functions (e.g. a relation's `target` / `getMappingEntity`), which it
   * rejects. Instead {@link deepCloneMetadata} deep-copies the mutable
   * containers (arrays, plain objects, Map/Set) while preserving class refs and
   * functions BY REFERENCE — cloning those would break `target ===` identity
   * checks the resolver relies on.
   */
  clone(newName: string, readOnly = false): MetadataLayer {
    const clonedLayer = new MetadataLayer(newName, readOnly);
    for (const [key, value] of this.metadata.entries()) {
      clonedLayer.metadata.set(key, deepCloneMetadata(value));
    }
    return clonedLayer;
  }

  /**
   * Clear the layer.
   */
  clear(): void {
    if (this.isReadOnly) {
      throw new Error(`Cannot clear read-only layer: ${this.name}`);
    }
    this.metadata.clear();
  }
}

/**
 * Structural deep clone tuned for decorator metadata, used by
 * {@link MetadataLayer.clone}.
 *
 * @internal Exported only so the copy-on-write behavior can be unit-tested
 * directly; not part of the supported public API.
 *
 * Deep-copies the mutable containers that tenant overlays must not share with
 * the public layer — arrays, plain objects, `Map`, `Set`, `Date` — while
 * returning everything that carries identity or behavior **by reference**:
 * - primitives and `symbol`
 * - functions and class constructors (`target`, `getMappingEntity`, …): cloning
 *   them would break the `===` identity checks the resolver and scanners rely on
 * - non-plain objects (class instances, etc.): generic cloning would drop their
 *   prototype/behavior, so they are shared as-is
 *
 * A `WeakMap` of already-cloned objects makes it cycle-safe and preserves
 * shared-reference structure within a single value.
 */
export function deepCloneMetadata<T>(value: T, seen = new WeakMap()): T {
  // Primitives, null, undefined, symbols, and functions (incl. class refs).
  if (value === null || typeof value !== "object") {
    return value;
  }

  const existing = seen.get(value as object);
  if (existing) return existing as T;

  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags) as unknown as T;
  }

  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    seen.set(value as object, arr);
    for (const item of value) arr.push(deepCloneMetadata(item, seen));
    return arr as unknown as T;
  }

  if (value instanceof Map) {
    const map = new Map();
    seen.set(value as object, map);
    // Keys keep their identity (Map lookups depend on it); only values are cloned.
    for (const [k, v] of value) map.set(k, deepCloneMetadata(v, seen));
    return map as unknown as T;
  }

  if (value instanceof Set) {
    const set = new Set();
    seen.set(value as object, set);
    for (const v of value) set.add(deepCloneMetadata(v, seen));
    return set as unknown as T;
  }

  // Only deep-clone plain objects. Class instances (non-plain prototype) carry
  // behavior, so they are shared by reference rather than structurally copied.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }

  const cloned: Record<string, unknown> = {};
  seen.set(value as object, cloned);
  for (const key of Object.keys(value as object)) {
    cloned[key] = deepCloneMetadata(
      (value as Record<string, unknown>)[key],
      seen,
    );
  }
  return cloned as T;
}
