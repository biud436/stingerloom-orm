/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */

/**
 * Base class for metadata scanners
 * Simplified version without IoC dependencies
 */
export class MetadataScanner {
  protected mapper: Map<string, any> = new Map();
  private uniqueIdCounter = 0;

  /**
   * Create a unique key for metadata storage
   */
  public createUniqueKey(): string {
    return `key_${Date.now()}_${this.uniqueIdCounter++}`;
  }

  /**
   * Store metadata with a key
   */
  public set<T>(key: string, value: T): void {
    this.mapper.set(key, value);
  }

  /**
   * Retrieve metadata by key
   */
  public get<T>(key: string): T | undefined {
    return this.mapper.get(key);
  }

  /**
   * Clear all metadata
   */
  public clear(): void {
    this.mapper.clear();
  }

  /**
   * Get all metadata values
   */
  public allMetadata<T = any>(): T[] {
    return Array.from(this.mapper.values());
  }

  /**
   * Check if a key exists
   */
  public has(key: string): boolean {
    return this.mapper.has(key);
  }

  /**
   * Get the size of the metadata store
   */
  public get size(): number {
    return this.mapper.size;
  }
}
