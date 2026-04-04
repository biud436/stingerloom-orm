import { ColumnTransformer } from "../decorators/Column";

/**
 * Per-dialect SQL type mapping for a custom column type.
 *
 * At least one dialect must be specified. If a dialect is omitted,
 * `castType()` falls back to the raw type name (uppercased).
 */
export interface CustomColumnTypeDefinition {
  mysql?: string;
  postgres?: string;
  sqlite?: string;

  /**
   * Optional bidirectional transformer applied automatically
   * when no explicit `@Column({ transformer })` is set.
   *
   * - `to`: entity value → DB value (INSERT/UPDATE)
   * - `from`: DB value → entity value (SELECT)
   */
  transformer?: ColumnTransformer;
}

export type DialectName = "mysql" | "postgres" | "sqlite";

/**
 * Global registry for user-defined column types.
 *
 * Allows registering custom database types (e.g. PostGIS `geometry`,
 * PostgreSQL `hstore`, `cidr`) with per-dialect SQL mappings and
 * optional value transformers.
 *
 * @example
 * ```ts
 * const registry = ColumnTypeRegistry.getInstance();
 * registry.register("geometry", {
 *   mysql: "GEOMETRY",
 *   postgres: "geometry(Point, 4326)",
 *   sqlite: "TEXT",
 *   transformer: {
 *     to: (value) => `POINT(${value.x} ${value.y})`,
 *     from: (raw) => parsePoint(raw),
 *   },
 * });
 * ```
 */
export class ColumnTypeRegistry {
  private static instance: ColumnTypeRegistry;

  private readonly types = new Map<string, CustomColumnTypeDefinition>();

  static getInstance(): ColumnTypeRegistry {
    if (!ColumnTypeRegistry.instance) {
      ColumnTypeRegistry.instance = new ColumnTypeRegistry();
    }
    return ColumnTypeRegistry.instance;
  }

  /**
   * Register a custom column type with per-dialect SQL mappings.
   *
   * @param name - The abstract type name to use in `@Column({ type: "..." })`.
   * @param definition - Per-dialect SQL types and optional transformer.
   */
  register(name: string, definition: CustomColumnTypeDefinition): void {
    this.types.set(name, definition);
  }

  /**
   * Remove a previously registered custom column type.
   */
  unregister(name: string): void {
    this.types.delete(name);
  }

  /**
   * Check if a custom column type is registered.
   */
  has(name: string): boolean {
    return this.types.has(name);
  }

  /**
   * Get the full definition for a custom column type.
   */
  get(name: string): CustomColumnTypeDefinition | undefined {
    return this.types.get(name);
  }

  /**
   * Resolve the SQL type string for a given dialect.
   * Returns `undefined` if the type is not registered or has no mapping for the dialect.
   */
  resolve(name: string, dialect: DialectName): string | undefined {
    const def = this.types.get(name);
    if (!def) return undefined;
    return def[dialect];
  }

  /**
   * Get the transformer for a custom column type (if any).
   */
  getTransformer(name: string): ColumnTransformer | undefined {
    return this.types.get(name)?.transformer;
  }

  /**
   * Get all registered custom type names.
   */
  getRegisteredNames(): string[] {
    return [...this.types.keys()];
  }

  /**
   * Remove all registered custom types. Primarily for testing.
   */
  clear(): void {
    this.types.clear();
  }

  /** @internal Reset the singleton. For testing only. */
  static resetInstance(): void {
    ColumnTypeRegistry.instance = undefined!;
  }
}
