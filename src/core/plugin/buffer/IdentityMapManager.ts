/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import { VERSION_TOKEN } from "../../../decorators/Version";
import { CREATE_TIMESTAMP_TOKEN } from "../../../decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../../../decorators/UpdateTimestamp";
import {
  getTenantColumnMetadata,
  isNonTenantEntity,
} from "../../../decorators/TenantColumn";
import { ColumnMetadata } from "../../../scanner/ColumnScanner";
import { FindOption } from "../../../dialects/FindOption";
import { MetadataContext } from "../../../metadata/MetadataContext";
import { InheritanceResolver } from "../../InheritanceResolver";
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
  private readonly inheritance = new InheritanceResolver();
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
        // Remove from trackedEntries if present (reference-only entries won't be there).
        // stateMap entry is deleted, not set to DETACHED — getState() falls back to
        // DETACHED for absent keys, and a strong Map entry would retain the instance
        // forever, defeating maxIdentityMapSize as a memory bound.
        this.trackedEntries?.delete(instance);
        this.stateMap.delete(instance);
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
   * Get the entity's column **property keys** and PK property keys.
   *
   * These are PROPERTY names (e.g. "fullName"), NOT DB column names. Every
   * buffer consumer uses them to read/write instance fields, snapshot for
   * dirty-checking, build identity keys, or hand data to `em.save`/`em.update`
   * (which map property → column themselves). Under a NamingStrategy the
   * @Column metadata's `name` becomes the snake_case DB column (e.g.
   * "full_name") which the instance never carries — reading `instance[name]`
   * yielded `undefined`, silently dropping renamed columns and throwing on a
   * camelCase PK. For raw SQL identifiers (the opt-in batch paths) use
   * {@link getColumnBindings} instead, which pairs each property with its DB
   * column.
   */
  getColumnInfo(entityClass: ClazzType<any>): {
    columnNames: string[];
    pkColumns: string[];
  } {
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];

    const columnNames = columns.map((c) => c.propertyKey ?? c.name!);
    const pkColumns = columns
      .filter((c) => c.options?.primary)
      .map((c) => c.propertyKey ?? c.name!);

    return { columnNames, pkColumns };
  }

  /**
   * Get property-key → DB-column-name bindings for an entity.
   *
   * Used by the raw-SQL batch INSERT/UPDATE paths, which must READ instance
   * values by property key but EMIT the DB column name (NamingStrategy- and
   * @Column({ name })-aware) as the SQL identifier.
   */
  getColumnBindings(entityClass: ClazzType<any>): {
    prop: string;
    column: string;
  }[] {
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];
    return columns.map((c) => ({
      prop: c.propertyKey ?? c.name!,
      column: c.name ?? c.propertyKey!,
    }));
  }

  /**
   * Resolve a single property key to its DB column name (NamingStrategy- and
   * @Column({ name })-aware). Falls back to the property key when unknown.
   */
  resolveColumnName(entityClass: ClazzType<any>, prop: string): string {
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];
    const match = columns.find((c) => (c.propertyKey ?? c.name!) === prop);
    return match?.name ?? prop;
  }

  /**
   * Whether the entity's primary key is entirely DB-generated
   * (auto-increment or a `generationStrategy` such as uuid / uuid-v7).
   *
   * When true, a present PK value reliably means the row already exists in the
   * database (it was loaded, not constructed), so persist() can treat it as
   * managed. When false, at least one PK column is application-assigned
   * (@PrimaryColumn / natural key), and a present PK does NOT imply the row
   * exists — a brand-new entity always carries its assigned PK.
   *
   * Returns false for keyless entities (no PK columns).
   */
  hasGeneratedPk(entityClass: ClazzType<any>): boolean {
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];
    const pkColumns = columns.filter((c) => c.options?.primary);
    if (pkColumns.length === 0) return false;
    return pkColumns.every(
      (c) =>
        c.options?.autoIncrement === true ||
        c.options?.generationStrategy != null,
    );
  }

  /**
   * Resolve the class whose NAME keys an entity in the identity map.
   *
   * The instance's concrete constructor is preferred over the class the
   * caller queried with — a polymorphic (root-class) query hydrates subclass
   * instances, and the key must be the same regardless of which side computed
   * it. On top of that:
   *
   * - SINGLE_TABLE / JOINED hierarchies share one PK space (one table / a
   *   shared root table), so the ROOT class keys the whole hierarchy — the
   *   same row loaded via the root and via the subclass is one identity.
   * - TABLE_PER_CLASS has an independent PK sequence per concrete table, so
   *   the concrete class keys it (root-keying would collide sibling rows).
   */
  resolveIdentityKeyClass(
    entityClass: ClazzType<any>,
    instance?: EntityInstance,
  ): ClazzType<any> {
    let cls = entityClass;
    const ctor = instance?.constructor;
    if (typeof ctor === "function" && ctor !== Object) {
      cls = ctor as ClazzType<any>;
    }
    const strategy = this.inheritance.getStrategy(cls);
    if (strategy === "SINGLE_TABLE" || strategy === "JOINED") {
      return this.inheritance.getRoot(cls) ?? cls;
    }
    return cls;
  }

  /**
   * Build a unique identity key for an entity instance based on class name + PK values.
   * Throws if any PK column is null/undefined.
   *
   * The keying class is resolved via {@link resolveIdentityKeyClass}, so an
   * STI/TPT row is keyed identically whether it was looked up through the
   * hierarchy root or tracked from its concrete `instance.constructor`.
   *
   * When the `"tenant_column"` strategy is active the key is prefixed with the
   * tenant (e.g. `"acme|User:id=1"`) so that the same PK value belonging to
   * different tenants cannot collide in the Identity Map. The prefix is read
   * from the instance's tenant column value when available, falling back to
   * the current `MetadataContext` tenant. `@NonTenantEntity` classes are
   * unprefixed.
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
    const keyClass = this.resolveIdentityKeyClass(entityClass, instance);
    const prefix = this.resolveTenantPrefixFromInstance(entityClass, instance);
    return `${prefix}${keyClass.name}:${pkParts}`;
  }

  /**
   * Compute the `"<tenant>|"` key prefix for an entity instance.
   *
   * Returns "" when the tenant_column strategy is inactive or the entity is
   * `@NonTenantEntity`. Uses the instance's own tenant column value when
   * populated (so `runUnscoped()` loads from multiple tenants stay distinct)
   * and falls back to the current `MetadataContext` tenant otherwise.
   */
  private resolveTenantPrefixFromInstance(
    entityClass: ClazzType<any>,
    instance: EntityInstance,
  ): string {
    const config = this.ctx.em.getTenantColumnConfig?.() ?? null;
    if (config === null) return "";
    if (isNonTenantEntity(entityClass)) return "";

    const userDeclared = getTenantColumnMetadata(entityClass);
    const colName = userDeclared?.name ?? userDeclared?.propertyKey ?? config.name;
    const propertyKey = userDeclared?.propertyKey ?? config.name;

    const raw = instance[colName] ?? instance[propertyKey];
    if (raw !== undefined && raw !== null) {
      return `${String(raw)}|`;
    }
    return `${MetadataContext.getCurrentTenant()}|`;
  }

  /**
   * Compute the `"<tenant>|"` key prefix for a context-only lookup (no
   * instance available yet — e.g. first-level cache probing).
   *
   * Returns `null` when the cache should be skipped entirely: under
   * `runUnscoped()` a single lookup might resolve to any tenant, so reusing
   * a cached reference would be unsafe.
   */
  private resolveTenantPrefixFromContext(
    entityClass: ClazzType<any>,
  ): string | null {
    const config = this.ctx.em.getTenantColumnConfig?.() ?? null;
    if (config === null) return "";
    if (isNonTenantEntity(entityClass)) return "";
    if (MetadataContext.isUnscoped()) return null;
    return `${MetadataContext.getCurrentTenant()}|`;
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
   * Get the @Version PROPERTY key for an entity class, or null if none.
   *
   * The token metadata holds the propertyKey as decorated, but
   * `applyNamingStrategyToEntities` rewrites it to the DB column name (e.g.
   * "row_version") for the SQL builders. Buffer code reads/writes INSTANCE
   * fields, so the value is mapped back to the property key here — otherwise
   * `instance["row_version"]` misses and the @Version fallback increment /
   * timestamp write lands on a stray property.
   */
  getVersionColumn(entityClass: ClazzType<any>): string | null {
    return this.resolveTokenPropertyKey(entityClass, VERSION_TOKEN);
  }

  /**
   * Get the @CreateTimestamp PROPERTY key for an entity class, or null if
   * none. See {@link getVersionColumn} for the NamingStrategy mapping.
   */
  getCreateTimestampColumn(entityClass: ClazzType<any>): string | null {
    return this.resolveTokenPropertyKey(entityClass, CREATE_TIMESTAMP_TOKEN);
  }

  /**
   * Get the @UpdateTimestamp PROPERTY key for an entity class, or null if
   * none. See {@link getVersionColumn} for the NamingStrategy mapping.
   */
  getUpdateTimestampColumn(entityClass: ClazzType<any>): string | null {
    return this.resolveTokenPropertyKey(entityClass, UPDATE_TIMESTAMP_TOKEN);
  }

  /**
   * Resolve a version/timestamp token value to the entity's property key.
   * The token holds either the propertyKey (no naming strategy / no rename)
   * or the DB column name (rewritten by `applyNamingStrategyToEntities` and
   * by explicit `@Column({ name })`). Property-key matches take precedence
   * over DB-name matches so a sibling column whose DB name shadows another
   * property cannot misroute the lookup.
   */
  private resolveTokenPropertyKey(
    entityClass: ClazzType<any>,
    token: symbol,
  ): string | null {
    const value = Reflect.getMetadata(token, entityClass) as string | undefined;
    if (!value) return null;
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];
    const byProp = columns.find((c) => c.propertyKey === value);
    if (byProp) return byProp.propertyKey!;
    const byName = columns.find((c) => c.name === value);
    return byName?.propertyKey ?? value;
  }

  /**
   * Check if an entity instance matches a simple WHERE clause (equality check).
   *
   * Only meaningful for a plain equality map — guard with
   * {@link isPureEqualityWhere} before calling for a WHERE that may contain
   * operator objects or AND/OR/NOT combinators.
   */
  matchesWhere(instance: EntityInstance, where: ColumnValueMap): boolean {
    for (const [col, val] of Object.entries(where)) {
      if (instance[col] !== val) return false;
    }
    return true;
  }

  /**
   * True iff `where` is a plain `{ col: scalar }` equality map that
   * {@link matchesWhere} can evaluate exactly against an in-memory instance —
   * no operator objects (`{ gte: 18 }`), arrays, or AND/OR/NOT combinators.
   *
   * Used to decide, after a bulk UPDATE/DELETE, whether the in-memory identity
   * map can be synced precisely or must be conservatively invalidated (an
   * operator WHERE is resolved by the database, and reproducing its exact row
   * selection in memory risks diverging from the real result).
   */
  isPureEqualityWhere(where: ColumnValueMap): boolean {
    for (const [key, val] of Object.entries(where)) {
      if (key === "OR" || key === "AND" || key === "NOT") return false;
      if (!this.isComparableScalar(val)) return false;
    }
    return true;
  }

  /**
   * True iff every SET value is a plain scalar safe to assign onto an in-memory
   * instance — excludes raw `Sql` expressions and other objects whose resulting
   * value is only known after the database evaluates them.
   */
  isPlainSetData(set: ColumnValueMap): boolean {
    for (const val of Object.values(set)) {
      if (val === null || val === undefined) continue;
      const t = typeof val;
      if (t === "string" || t === "number" || t === "boolean" || t === "bigint") continue;
      if (val instanceof Date) continue;
      return false;
    }
    return true;
  }

  private isComparableScalar(val: unknown): boolean {
    if (val === null) return true;
    const t = typeof val;
    return t === "string" || t === "number" || t === "boolean" || t === "bigint";
  }

  /**
   * Remove a tracked instance from the identity map, tracked entries, and state
   * map. The identity key is computed from the entry's own pkColumns before the
   * entry is deleted, so this stays O(1) (no scan of the identity map).
   */
  detachTracked(
    instance: EntityInstance,
    trackedEntries: Map<EntityInstance, TrackedEntry>,
  ): void {
    const entry = trackedEntries.get(instance);
    if (entry) {
      const key = this.buildIdentityKey(entry.entity, instance, entry.pkColumns);
      this.identityMap.delete(key);
      trackedEntries.delete(instance);
    }
    this.stateMap.delete(instance);
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
      option.onlyDeleted ||
      option.withoutTenantScope ||
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

    // Skip first-level cache entirely in unscoped mode — a PK lookup may
    // resolve to a different tenant than the one whose entry is cached.
    const tenantPrefix = this.resolveTenantPrefixFromContext(entityClass);
    if (tenantPrefix === null) return null;

    const pkParts = pkColumns
      .map((pk) => `${pk}=${whereObj[pk]}`)
      .join(",");
    // Key by the same class buildIdentityKey uses (STI/TPT root), so a
    // root-class cache probe hits an entry tracked from a subclass instance.
    // The caller must still `instanceof`-guard the hit — a root-keyed entry
    // may be a different subtype than the one being queried.
    const keyClass = this.resolveIdentityKeyClass(entityClass);
    return `${tenantPrefix}${keyClass.name}:${pkParts}`;
  }

  private isLiteralScalar(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return true;
    if (value instanceof Date) return true;
    return false;
  }
}
