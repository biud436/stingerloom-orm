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
import { requestedRelationNames } from "../../RelationTree";
import { OrmError } from "../../../errors/OrmError";
import { OrmErrorCode } from "../../../errors/OrmErrorCode";
import { MetadataContext } from "../../../metadata/MetadataContext";
import { SchemaQualifiedStrategy, SearchPathStrategy } from "../../TenantQueryStrategy";
import { InheritanceResolver } from "../../InheritanceResolver";
import { RelationMetadataResolver, referencedColumnIn } from "../../RelationMetadataResolver";
import { readLoadedRelationValue } from "./CollectionTracker";
import { PluginContext } from "../PluginContext";
import { EntityState } from "./EntityUnitState";
import type { TrackedEntry } from "./BufferEntry";
import type { EntityManager } from "../../EntityManager";

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
 * A foreign key the entity's own row holds — the join column of a
 * `@ManyToOne` or an owning `@OneToOne` — as the buffer reads and writes it:
 * through an instance property, like every other column.
 */
export interface ForeignKeyField {
  /** The relation property (`author`). */
  relation: string;
  /**
   * The instance property holding the key: the declared `@Column` on the
   * join column, otherwise `fkProperty`, otherwise `${relation}Id` — the
   * property reads hydrate the key into.
   */
  property: string;
  /** The join column. */
  column: string;
  /** Whether a declared `@Column` is the join column (then `property` is already a column). */
  declared: boolean;
  /** The related entity. */
  getTarget: () => ClazzType<unknown>;
  /** The related column the key is, when not the primary key. */
  references?: string;
}

/** A foreign key whose target had no key yet when the flush reached the row. */
export interface PendingForeignKey {
  field: ForeignKeyField;
  /** The related instance, keyless when it was read. */
  target: EntityInstance;
}

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
  private readonly relations = new RelationMetadataResolver();
  private readonly foreignKeyFieldCache = new Map<ClazzType<any>, ForeignKeyField[]>();
  private _maxSize: number | undefined;
  /**
   * External reference to the WriteBuffer's trackedEntries map.
   * Set once by WriteBuffer after construction via `setTrackedEntries()`.
   * Used by eviction to skip dirty entities.
   */
  private trackedEntries?: Map<any, TrackedEntry>;
  private snapshotStrategy?: {
    snapshot(instance: any, cols: string[]): Record<string, any>;
    diff(
      instance: any,
      snapshot: Record<string, any>,
      columnNames: string[],
      pkColumns: string[],
    ): Record<string, any> | null;
  };

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
    strategy: {
      snapshot(instance: any, cols: string[]): Record<string, any>;
      diff(
        instance: any,
        snapshot: Record<string, any>,
        columnNames: string[],
        pkColumns: string[],
      ): Record<string, any> | null;
    },
  ): void {
    this.trackedEntries = entries;
    this.snapshotStrategy = strategy;
  }

  /**
   * The tracked entry for an instance, if the buffer is tracking it.
   * Returns undefined when the trackedEntries map was never linked — callers
   * then fall back to untracked (save-always) semantics.
   */
  getTrackedEntry(instance: EntityInstance): TrackedEntry | undefined {
    return this.trackedEntries?.get(instance);
  }

  /** Column diff of a tracked entry against its snapshot (null = clean). */
  diffTracked(entry: TrackedEntry): ColumnValueMap | null {
    if (!this.snapshotStrategy) return null;
    return this.snapshotStrategy.diff(
      this.foreignKeyView(entry.instance, entry.entity),
      entry.snapshot,
      entry.columnNames,
      entry.pkColumns,
    );
  }

  /** Re-baseline a tracked entry's snapshot to the instance's current state. */
  rebaselineSnapshot(entry: TrackedEntry): void {
    if (!this.snapshotStrategy) return;
    entry.snapshot = this.snapshotStrategy.snapshot(entry.instance, entry.columnNames);
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
   * Whether an entity class is registered with the EntityManager.
   *
   * The non-throwing predicate for callers that treat an unregistered class
   * as "skip" (lazy injection, cascade walks) — use {@link validateEntity}
   * only where an unregistered class is a caller error.
   */
  isRegistered(entityClass: ClazzType<any>): boolean {
    return this.ctx.getEntities().includes(entityClass);
  }

  /**
   * Validate that an entity class is registered with the EntityManager.
   *
   * @throws OrmError with code `ENTITY_METADATA_NOT_FOUND` — callers that
   *         need to distinguish this from other failures match on the code,
   *         never on the message.
   */
  validateEntity(entityClass: ClazzType<any>): void {
    if (!this.isRegistered(entityClass)) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
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

    const columnNames = columns.map((c) => c.propertyKey ?? c.name);
    const pkColumns = columns
      .filter((c) => c.options?.primary)
      .map((c) => c.propertyKey ?? c.name);

    // A foreign key with no declared @Column is still a column of the row:
    // snapshot, diff and the save payload carry it under its FK property.
    for (const field of this.foreignKeyFields(entityClass)) {
      if (!field.declared && !columnNames.includes(field.property)) {
        columnNames.push(field.property);
      }
    }

    return { columnNames, pkColumns };
  }

  /**
   * The foreign keys `entityClass`'s rows hold (see {@link ForeignKeyField}),
   * read through the same relation metadata the core write path uses.
   */
  foreignKeyFields(entityClass: ClazzType<any>): ForeignKeyField[] {
    const cached = this.foreignKeyFieldCache.get(entityClass);
    if (cached) return cached;
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];
    const fields: ForeignKeyField[] = [];
    for (const rel of this.relations.resolveForeignKeyRelations(entityClass)) {
      const backing = columns.find((c) => c.name === rel.joinColumn);
      const property = backing
        ? (backing.propertyKey ?? backing.name)
        : (rel.fkProperty ?? `${rel.propertyKey}Id`);
      // The key must never be written over the relation property itself.
      if (property === rel.propertyKey) continue;
      fields.push({
        relation: rel.propertyKey,
        property,
        column: rel.joinColumn,
        declared: !!backing,
        getTarget: rel.getRelatedEntity,
        references: rel.references,
      });
    }
    this.foreignKeyFieldCache.set(entityClass, fields);
    return fields;
  }

  /**
   * The key a related instance contributes to a foreign key: its value of
   * the referenced column (the primary key unless `references` names
   * another). Undefined or null while the instance has none.
   */
  referencedKeyOf(target: EntityInstance, field: ForeignKeyField): unknown {
    const property = this.referencedProperty(field);
    return property ? target[property] : undefined;
  }

  /**
   * The property of the related entity a foreign key holds: the column
   * `references` names, otherwise the primary key.
   */
  referencedProperty(field: ForeignKeyField): string | undefined {
    const TargetClass = field.getTarget() as ClazzType<any>;
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, TargetClass.prototype) ?? [];
    const column = referencedColumnIn(columns, field.references);
    return column ? (column.propertyKey ?? column.name) : undefined;
  }

  /**
   * The foreign-key values `instance`'s loaded relations state, by FK
   * property, with the precedence `save()` applies: a relation set to
   * `null` clears the key, a related instance contributes its referenced
   * key, a bare value is the key itself. An unloaded relation (a lazy proxy)
   * or one never set says nothing, leaving the FK property as it is.
   *
   * A related instance without its key yet is returned as pending: a row
   * this flush inserts later, whose key is only known then.
   */
  resolveForeignKeys(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
    exceptRelation?: string,
  ): { values: Map<string, unknown>; pending: PendingForeignKey[] } {
    const values = new Map<string, unknown>();
    const pending: PendingForeignKey[] = [];
    if (instance === null || typeof instance !== "object") return { values, pending };
    for (const field of this.foreignKeyFields(entityClass)) {
      if (field.relation === exceptRelation) continue;
      const own = Object.getOwnPropertyDescriptor(instance, field.relation);
      if (!own || !("value" in own) || own.value === undefined) continue;
      if (own.value === null) {
        values.set(field.property, null);
        continue;
      }
      if (typeof own.value !== "object") {
        values.set(field.property, own.value);
        continue;
      }
      const target = readLoadedRelationValue(instance, field.relation);
      if (!target || Array.isArray(target)) continue;
      const key = this.referencedKeyOf(target, field);
      if (key === undefined || key === null) {
        pending.push({ field, target });
      } else {
        values.set(field.property, key);
      }
    }
    return { values, pending };
  }

  /**
   * Writes the foreign keys `instance`'s relations state onto their FK
   * properties (see {@link resolveForeignKeys}), returning the ones whose
   * target has no key yet.
   */
  syncForeignKeys(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
    exceptRelation?: string,
  ): PendingForeignKey[] {
    const { values, pending } = this.resolveForeignKeys(instance, entityClass, exceptRelation);
    for (const [property, value] of values) instance[property] = value;
    return pending;
  }

  /**
   * `instance` as a diff sees it once its relations are written onto the FK
   * properties — without touching the instance, for the read-only views
   * (`dirty()`, `preview()`, eviction checks).
   */
  foreignKeyView(instance: EntityInstance, entityClass: ClazzType<any>): EntityInstance {
    const { values } = this.resolveForeignKeys(instance, entityClass);
    let view: EntityInstance | undefined;
    for (const [property, value] of values) {
      if (instance[property] === value) continue;
      view ??= Object.create(instance);
      Object.defineProperty(view, property, { value, enumerable: true, writable: true });
    }
    return view ?? instance;
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
    const bindings = columns.map((c) => ({
      prop: c.propertyKey ?? c.name,
      column: c.name ?? c.propertyKey!,
    }));
    for (const field of this.foreignKeyFields(entityClass)) {
      if (!field.declared) bindings.push({ prop: field.property, column: field.column });
    }
    return bindings;
  }

  /**
   * Resolve a single property key to its DB column name (NamingStrategy- and
   * @Column({ name })-aware). Falls back to the property key when unknown.
   */
  resolveColumnName(entityClass: ClazzType<any>, prop: string): string {
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];
    const match = columns.find((c) => (c.propertyKey ?? c.name) === prop);
    if (match) return match.name ?? prop;
    const field = this.foreignKeyFields(entityClass).find((f) => f.property === prop);
    return field?.column ?? prop;
  }

  /**
   * Whether the database generates every primary key column
   * (auto-increment).
   *
   * When true, a present key reliably means the row already exists: the
   * value can only have come from the database. A key the application
   * chooses — a natural or composite key (@PrimaryColumn), or a uuid the
   * ORM generates on the client and the caller may set itself — is present
   * on a brand-new entity too, so its presence says nothing about the row;
   * see {@link rowExistsForChosenKey}.
   *
   * Returns false for keyless entities (no PK columns).
   */
  hasDatabaseGeneratedPk(entityClass: ClazzType<any>): boolean {
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];
    const pkColumns = columns.filter((c) => c.options?.primary);
    if (pkColumns.length === 0) return false;
    return pkColumns.every((c) => c.options?.autoIncrement === true);
  }

  /**
   * Whether a row with the instance's key exists, for a key the application
   * chooses. `save()` updates such a row and inserts otherwise, so the flush
   * asks first to report and announce the write it is about to make.
   * False when the key is incomplete or the database generates it.
   */
  async rowExistsForChosenKey(
    txEm: EntityManager,
    entityClass: ClazzType<any>,
    instance: EntityInstance,
    pkColumns: string[],
  ): Promise<boolean> {
    if (pkColumns.length === 0 || this.hasDatabaseGeneratedPk(entityClass)) return false;
    const complete = pkColumns.every(
      (pk) => instance[pk] !== undefined && instance[pk] !== null,
    );
    if (!complete) return false;
    return txEm.exists(entityClass, this.buildPkWhere(instance, pkColumns) as any, true);
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
   * When rows differ per tenant the key is prefixed with the tenant (e.g.
   * `"acme|User:id=1"`) so that the same PK value belonging to different
   * tenants cannot collide in the Identity Map — see {@link tenantKeying}.
   * Under `"tenant_column"` the prefix is read from the instance's tenant
   * column value when available, falling back to the current
   * `MetadataContext` tenant; under the schema strategies it is the current
   * tenant. `@NonTenantEntity` classes are unprefixed.
   */
  buildIdentityKey(
    entityClass: ClazzType<any>,
    instance: EntityInstance,
    pkColumns: string[],
  ): string {
    const pkParts = pkColumns.map((pk) => {
      const value = instance[pk];
      if (value === undefined || value === null) {
        // Code PRIMARY_KEY_NOT_FOUND — callers that swallow "no usable PK"
        // (merge, detachByPk, identity-map probes) match on it, not on the
        // message.
        throw new OrmError(
          OrmErrorCode.PRIMARY_KEY_NOT_FOUND,
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
   * How a row of `entityClass` is told apart per tenant, which decides
   * whether its identity key names the tenant:
   *
   * - `"column"` — `tenant_column`: one table holds every tenant's rows,
   *   told apart by the tenant column.
   * - `"schema"` — `search_path` / `schema_qualified` on PostgreSQL: each
   *   tenant reads its own schema, so one PK value names a different row per
   *   tenant while one EntityManager (and buffer) serves them all.
   * - `null` — rows are shared: a `@NonTenantEntity`, a table pinned to a
   *   schema, another strategy, or the schema strategies on MySQL / SQLite,
   *   where they do not change which table a query reads.
   */
  private tenantKeying(entityClass: ClazzType<any>): "column" | "schema" | null {
    if (isNonTenantEntity(entityClass)) return null;
    if ((this.ctx.em.getTenantColumnConfig?.() ?? null) !== null) return "column";
    if (!this.ctx.isPostgres()) return null;
    const strategy = this.ctx.em.getTenantStrategy?.();
    if (
      !(strategy instanceof SearchPathStrategy) &&
      !(strategy instanceof SchemaQualifiedStrategy)
    ) {
      return null;
    }
    if (this.ctx.em.resolveEntitySchema?.(entityClass) !== undefined) return null;
    return "schema";
  }

  /**
   * The `"<tenant>|"` prefix under the schema strategies: the current tenant,
   * or "" in the default (`"public"`) context, which reads the default schema
   * with or without an explicit `run("public", ...)`.
   */
  private schemaTenantPrefix(): string {
    const tenant = MetadataContext.getCurrentTenant();
    return tenant === "public" ? "" : `${tenant}|`;
  }

  /**
   * Compute the `"<tenant>|"` key prefix for an entity instance.
   *
   * Returns "" when rows of the entity are shared (see {@link tenantKeying}).
   * Under `tenant_column`, uses the instance's own tenant column value when
   * populated (so `runUnscoped()` loads from multiple tenants stay distinct)
   * and falls back to the current `MetadataContext` tenant otherwise.
   */
  private resolveTenantPrefixFromInstance(
    entityClass: ClazzType<any>,
    instance: EntityInstance,
  ): string {
    const keying = this.tenantKeying(entityClass);
    if (keying === null) return "";
    if (keying === "schema") return this.schemaTenantPrefix();
    const config = this.ctx.em.getTenantColumnConfig!()!;

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
    const keying = this.tenantKeying(entityClass);
    if (keying === null) return "";
    if (keying === "schema") return this.schemaTenantPrefix();
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
   * The parent property the rows of a OneToMany hold in their join column,
   * when it is not the primary key: the column the owning `@ManyToOne`
   * (`mappedBy` on `ChildEntity`) references. Undefined for the primary key.
   */
  oneToManyReferencedProperty(
    entityClass: ClazzType<any>,
    ChildEntity: ClazzType<any>,
    mappedBy: string,
  ): string | undefined {
    const owner = this.relations
      .resolveManyToOneMetadata(ChildEntity)
      .find((m) => m.columnName === mappedBy);
    if (!owner?.references) return undefined;
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];
    const column = referencedColumnIn(columns, owner.references);
    if (!column || column.options?.primary) return undefined;
    return column.propertyKey ?? column.name;
  }

  /**
   * The value of `instance` that the rows of its OneToMany hold in their
   * join column: the referenced column's value (see
   * {@link oneToManyReferencedProperty}), otherwise the primary key.
   */
  oneToManyParentKey(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
    ChildEntity: ClazzType<any>,
    mappedBy: string,
  ): any {
    const property = this.oneToManyReferencedProperty(entityClass, ChildEntity, mappedBy);
    return property ? instance[property] : this.getParentPkValue(instance, entityClass);
  }

  /**
   * {@link oneToManyParentKey} for a write that assigns it to child rows:
   * a parent without the referenced value would give every child a NULL
   * key, so that is refused.
   */
  requireOneToManyParentKey(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
    ChildEntity: ClazzType<any>,
    mappedBy: string,
    relation: string,
  ): any {
    const property = this.oneToManyReferencedProperty(entityClass, ChildEntity, mappedBy);
    if (!property) return this.getParentPkValue(instance, entityClass);
    const value = instance[property];
    if (value === undefined || value === null) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        `Cannot cascade ${entityClass.name}.${relation}: its rows reference ${entityClass.name}.${property}, which the ${entityClass.name} being flushed does not state.`,
        `Set "${property}" on the ${entityClass.name}.`,
      );
    }
    return value;
  }

  /**
   * Extract only column values from an instance (no relation properties).
   * This ensures CascadeHandler in em.save() won't fire — WriteBuffer
   * handles cascade directly.
   *
   * The copy keeps the instance's prototype: save() runs lifecycle hooks
   * (`@BeforeInsert`, defineEntity `hooks`) as methods of the object it is
   * given, and a plain object has none.
   */
  extractColumnData(
    instance: EntityInstance,
    columnNames: string[],
  ): ColumnValueMap {
    const data: ColumnValueMap = Object.create(Object.getPrototypeOf(instance));
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
      requestedRelationNames(option.relations)?.length ||
      (option.withCount && Object.keys(option.withCount).length > 0) ||
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
