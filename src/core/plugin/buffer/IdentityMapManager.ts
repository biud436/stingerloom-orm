/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import { VERSION_TOKEN } from "../../../decorators/Version";
import { CREATE_TIMESTAMP_TOKEN } from "../../../decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../../../decorators/UpdateTimestamp";
import { ColumnMetadata } from "../../../scanner/ColumnScanner";
import { FindOption } from "../../../dialects/FindOption";
import { PluginContext } from "../PluginContext";
import { EntityState } from "./EntityUnitState";
import type { TrackedEntry } from "./BufferEntry";

/**
 * Semantic type alias for entity instances crossing module boundaries.
 * Unavoidable `any` in a generic ORM — this alias provides clarity.
 */
export type EntityInstance = any;

/**
 * Column name → value mapping extracted from an entity instance.
 */
export type ColumnValueMap = Record<string, any>;

/**
 * Manages the Identity Map and entity metadata helpers for WriteBuffer.
 *
 * The Identity Map ensures that the same database row (identified by
 * entity class + PK) is always represented by the same object reference.
 *
 * When `maxSize` is set, applies LRU eviction to keep the map bounded.
 * Dirty, NEW, and REMOVED entities are never evicted.
 */
export class IdentityMapManager {
  readonly identityMap = new Map<string, EntityInstance>();
  readonly stateMap = new Map<EntityInstance, string>();
  private readonly ctx: PluginContext;
  private _maxSize: number | undefined;
  /**
   * External reference to the WriteBuffer's trackedEntries map.
   * Set once by WriteBuffer after construction via `setTrackedEntries()`.
   * Used by eviction to skip dirty entities.
   */
  private trackedEntries?: Map<any, TrackedEntry>;
  private snapshotStrategy?: { snapshot(instance: any, cols: string[]): Record<string, any> };

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  /**
   * Configure the maximum Identity Map size for LRU eviction.
   */
  setMaxSize(max: number | undefined): void {
    this._maxSize = max;
  }

  get maxSize(): number | undefined {
    return this._maxSize;
  }

  /**
   * Link the WriteBuffer's trackedEntries and snapshot strategy
   * so eviction can check dirtiness.
   */
  setTrackedEntries(
    entries: Map<any, TrackedEntry>,
    strategy: { snapshot(instance: any, cols: string[]): Record<string, any> },
  ): void {
    this.trackedEntries = entries;
    this.snapshotStrategy = strategy;
  }

  /**
   * Record an access to keep LRU order fresh.
   * Re-inserting into Map moves the key to the end (most-recently-used).
   */
  touch(key: string): void {
    if (this._maxSize === undefined) return;
    const val = this.identityMap.get(key);
    if (val !== undefined) {
      this.identityMap.delete(key);
      this.identityMap.set(key, val);
    }
  }

  /**
   * Evict least-recently-used clean entries if the map exceeds maxSize.
   * Dirty, NEW, and REMOVED entities are never evicted.
   */
  evictIfNeeded(): void {
    if (this._maxSize === undefined) return;
    if (this.identityMap.size <= this._maxSize) return;

    const toEvict = this.identityMap.size - this._maxSize;
    let evicted = 0;
    const keysToDelete: string[] = [];

    // Map iteration order = insertion order = oldest first (LRU candidates)
    for (const [key, instance] of this.identityMap) {
      if (evicted >= toEvict) break;
      if (this.isEvictable(instance)) {
        keysToDelete.push(key);
        evicted++;
      }
    }

    for (const key of keysToDelete) {
      const instance = this.identityMap.get(key);
      this.identityMap.delete(key);
      if (instance !== undefined) {
        // Remove from trackedEntries if present (reference-only entries won't be there)
        this.trackedEntries?.delete(instance);
        this.stateMap.set(instance, EntityState.DETACHED);
      }
    }
  }

  /**
   * Check if an entity instance can be safely evicted.
   * Returns false for dirty, NEW, or REMOVED entities.
   */
  private isEvictable(instance: EntityInstance): boolean {
    const state = this.stateMap.get(instance);
    if (state === EntityState.NEW || state === EntityState.REMOVED) return false;

    // Check if instance is snapshot-tracked and dirty
    if (this.trackedEntries && this.snapshotStrategy) {
      const entry = this.trackedEntries.get(instance);
      if (entry) {
        if (entry.explicitDirty) return false;
        const current = this.snapshotStrategy.snapshot(instance, entry.columnNames);
        for (const col of entry.columnNames) {
          if (current[col] !== entry.snapshot[col]) return false;
        }
      }
    }

    return true;
  }

  /**
   * Validate that an entity class is registered with the EntityManager.
   */
  validateEntity(entityClass: ClazzType<any>): void {
    const entities = this.ctx.getEntities();
    if (!entities.includes(entityClass)) {
      throw new Error(
        `Cannot track instance of "${entityClass.name}": not a registered entity. ` +
        `Make sure the class is decorated with @Entity() and registered with the EntityManager.`,
      );
    }
  }

  /**
   * Get column names and PK column names for an entity class.
   */
  getColumnInfo(entityClass: ClazzType<any>): {
    columnNames: string[];
    pkColumns: string[];
  } {
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];

    const columnNames = columns.map((c) => c.name ?? c.propertyKey!);
    const pkColumns = columns
      .filter((c) => c.options?.primary)
      .map((c) => c.name ?? c.propertyKey!);

    return { columnNames, pkColumns };
  }

  /**
   * Build a unique identity key for an entity instance based on class name + PK values.
   * Throws if any PK column is null/undefined.
   */
  buildIdentityKey(
    entityClass: ClazzType<any>,
    instance: EntityInstance,
    pkColumns: string[],
  ): string {
    const pkParts = pkColumns.map((pk) => {
      const value = instance[pk];
      if (value === undefined || value === null) {
        throw new Error(
          `Cannot track instance of "${entityClass.name}": PK column "${pk}" is ${value}. ` +
          `Only persisted entities with assigned PK values can be tracked. ` +
          `Use save() to queue new entities for insertion instead.`,
        );
      }
      return `${pk}=${value}`;
    }).join(",");
    return `${entityClass.name}:${pkParts}`;
  }

  /**
   * Build a WHERE clause from PK columns of a tracked entry.
   */
  buildPkWhere(instance: EntityInstance, pkColumns: string[]): ColumnValueMap {
    const where: ColumnValueMap = {};
    for (const pk of pkColumns) {
      where[pk] = instance[pk];
    }
    return where;
  }

  /**
   * Get the PK value(s) of an entity instance.
   * Returns scalar for single-column PK, object for composite PK.
   */
  getParentPkValue(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
  ): any {
    const { pkColumns } = this.getColumnInfo(entityClass);
    if (pkColumns.length === 1) return instance[pkColumns[0]];
    const pk: ColumnValueMap = {};
    for (const col of pkColumns) pk[col] = instance[col];
    return pk;
  }

  /**
   * Extract only column values from an instance (no relation properties).
   * This ensures CascadeHandler in em.save() won't fire — WriteBuffer
   * handles cascade directly.
   */
  extractColumnData(
    instance: EntityInstance,
    columnNames: string[],
  ): ColumnValueMap {
    const data: ColumnValueMap = {};
    for (const col of columnNames) {
      if (instance[col] !== undefined) data[col] = instance[col];
    }
    return data;
  }

  /**
   * Get the @Version column name for an entity class, or null if none.
   */
  getVersionColumn(entityClass: ClazzType<any>): string | null {
    return Reflect.getMetadata(VERSION_TOKEN, entityClass) ?? null;
  }

  /**
   * Get the @CreateTimestamp column name for an entity class, or null if none.
   */
  getCreateTimestampColumn(entityClass: ClazzType<any>): string | null {
    return Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, entityClass) ?? null;
  }

  /**
   * Get the @UpdateTimestamp column name for an entity class, or null if none.
   */
  getUpdateTimestampColumn(entityClass: ClazzType<any>): string | null {
    return Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, entityClass) ?? null;
  }

  /**
   * Check if an entity instance matches a simple WHERE clause (equality check).
   */
  matchesWhere(instance: EntityInstance, where: ColumnValueMap): boolean {
    for (const [col, val] of Object.entries(where)) {
      if (instance[col] !== val) return false;
    }
    return true;
  }

  /**
   * Check whether a FindOption is a simple PK-only equality lookup
   * eligible for first-level cache (Identity Map hit → skip DB).
   *
   * Returns the identity map key if eligible, or null otherwise.
   */
  tryBuildCacheKey<T>(
    entityClass: ClazzType<T>,
    option: FindOption<T>,
  ): string | null {
    if (
      option.relations?.length ||
      option.select ||
      option.orderBy ||
      option.limit != null ||
      option.skip != null ||
      option.take != null ||
      option.groupBy?.length ||
      option.having?.length ||
      option.lock ||
      option.distinct ||
      option.useMaster ||
      option.withDeleted ||
      option.timeout != null
    ) {
      return null;
    }

    const where = option.where;
    if (!where || Array.isArray(where)) return null;

    const whereObj = where as Record<string, unknown>;
    if (whereObj.OR || whereObj.AND || whereObj.NOT) return null;

    const { pkColumns } = this.getColumnInfo(entityClass);
    if (pkColumns.length === 0) return null;

    const whereKeys = Object.keys(whereObj);
    if (whereKeys.length !== pkColumns.length) return null;
    if (!pkColumns.every((pk) => whereKeys.includes(pk))) return null;

    for (const pk of pkColumns) {
      if (!this.isLiteralScalar(whereObj[pk])) return null;
    }

    const pkParts = pkColumns
      .map((pk) => `${pk}=${whereObj[pk]}`)
      .join(",");
    return `${entityClass.name}:${pkParts}`;
  }

  private isLiteralScalar(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return true;
    if (value instanceof Date) return true;
    return false;
  }
}
