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
   * Clone the current layer into a new layer.
   * Values that cannot be deep-cloned (functions, class references, etc.)
   * fall back to a shallow copy.
   */
  clone(newName: string, readOnly = false): MetadataLayer {
    const clonedLayer = new MetadataLayer(newName, readOnly);
    for (const [key, value] of this.metadata.entries()) {
      try {
        clonedLayer.metadata.set(key, structuredClone(value));
      } catch {
        // structuredClone failed (functions, class references, etc.) — fall back to shallow copy
        clonedLayer.metadata.set(key, { ...value });
      }
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
