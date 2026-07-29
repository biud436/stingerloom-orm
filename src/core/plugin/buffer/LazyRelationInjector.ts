/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { MANY_TO_ONE_TOKEN } from "../../../decorators/ManyToOne";
import { ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../../../decorators/OneToMany";
import { ONE_TO_ONE_TOKEN } from "../../../decorators/OneToOne";
import { MANY_TO_MANY_TOKEN } from "../../../decorators/ManyToMany";
import { PluginContext } from "../PluginContext";
import { IdentityMapManager, EntityInstance } from "./IdentityMapManager";
import { resolveFkColumn } from "./CollectionTracker";
import { injectLazyProxy, suppressUnhandledRejection } from "../../LazyLoader";
import type { ManyToOneMetadata } from "../../../decorators/ManyToOne";
import type { OneToOneMetadata } from "../../../decorators/OneToOne";
import type { ManyToManyMetadata } from "../../../decorators/ManyToMany";

/**
 * Callback to resolve identity map membership for loaded entities.
 * Returns the existing tracked instance if one exists, otherwise tracks the new one.
 */
export type ResolveIdentityFn = (entityClass: ClazzType<any>, instance: EntityInstance) => EntityInstance;

/**
 * Callback fired when a lazy O2M/M2M collection proxy first materializes,
 * so the buffer can capture the loaded items as a change-tracking baseline.
 */
export type CollectionMaterializedFn = (instance: EntityInstance, propertyKey: string) => void;

/**
 * "Is this relation property already loaded or proxied?" — decided WITHOUT
 * reading the property. A raw `instance[key] !== undefined` check fires any
 * previously injected lazy getter (a hidden query on re-injection). An own
 * accessor means a proxy is already installed; an own data property counts
 * only when it holds a value. Prototype getters (user-defined) are read as
 * before — they are the user's code, not a lazy loader.
 */
function isRelationOccupied(instance: any, propertyKey: string): boolean {
  const desc = Object.getOwnPropertyDescriptor(instance, propertyKey);
  if (!desc) return instance[propertyKey] !== undefined;
  if (!("value" in desc)) return true;
  return desc.value !== undefined;
}

/**
 * Injects lazy-loading proxies on unloaded relation properties.
 *
 * When a proxied property is accessed:
 * - First access returns a Promise that loads from DB.
 * - After resolution, the property is replaced with the actual value.
 * - Loaded entities are registered in the buffer's Identity Map.
 *
 * Supports: @ManyToOne, @OneToMany, @OneToOne, @ManyToMany
 */
export class LazyRelationInjector {
  private readonly ctx: PluginContext;
  private readonly idMap: IdentityMapManager;
  private readonly resolveIdentity: ResolveIdentityFn;
  private readonly onCollectionMaterialized?: CollectionMaterializedFn;

  constructor(
    ctx: PluginContext,
    idMap: IdentityMapManager,
    resolveIdentity: ResolveIdentityFn,
    onCollectionMaterialized?: CollectionMaterializedFn,
  ) {
    this.ctx = ctx;
    this.idMap = idMap;
    this.resolveIdentity = resolveIdentity;
    this.onCollectionMaterialized = onCollectionMaterialized;
  }

  /**
   * Inject lazy-loading proxies on all relation properties of an instance.
   *
   * @param hydrateStub — provided for a PK-only getReference() stub. A stub
   *   carries no FK values, so FK-dependent relations (@ManyToOne / owning
   *   @OneToOne) cannot resolve their target eagerly; with this callback the
   *   proxy hydrates the stub's own row first, then chains into the normal
   *   relation load. Without it, FK-less properties are simply skipped.
   */
  injectLazyRelations(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
    hydrateStub?: () => Promise<void>,
  ): void {
    this.injectLazyManyToOne(instance, entityClass, hydrateStub);
    this.injectLazyOneToMany(instance, entityClass);
    this.injectLazyOneToOne(instance, entityClass, hydrateStub);
    this.injectLazyManyToMany(instance, entityClass);
  }

  /**
   * @ManyToOne lazy: access `instance.author` -> loads Author by FK value.
   */
  private injectLazyManyToOne(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
    hydrateStub?: () => Promise<void>,
  ): void {
    const meta: ManyToOneMetadata<any>[] =
      Reflect.getMetadata(MANY_TO_ONE_TOKEN, entityClass) ?? [];

    for (const rel of meta) {
      // Skip if already loaded or proxied
      if (isRelationOccupied(instance, rel.columnName)) continue;

      // FK value: a hydrated entity stores an @RelationColumn / snake_case FK
      // under its shadow property (e.g. user_id -> userId), so read the shadow
      // first and fall back to the raw join column for plain @ManyToOne FKs.
      const fkShadow = rel.option?.fkProperty ?? `${rel.columnName}Id`;
      const fkColumn = rel.joinColumn ?? rel.columnName;
      const fkValue = instance[fkShadow] ?? instance[fkColumn];
      // A PK-only stub has no FK yet — inject anyway when it can hydrate
      // itself on first access.
      if ((fkValue === undefined || fkValue === null) && !hydrateStub) continue;

      const RelatedEntity = rel.getMappingEntity() as any as ClazzType<any>;
      try { this.idMap.validateEntity(RelatedEntity); } catch { continue; }

      const relatedPkCols = this.idMap.getColumnInfo(RelatedEntity).pkColumns;
      const refColumn = rel.references ?? (relatedPkCols.length === 1 ? relatedPkCols[0] : null);
      if (!refColumn) continue;

      // Inside the loader the proxy is already installed on rel.columnName —
      // when the legacy fallback makes fkColumn that same property, reading it
      // would re-enter the getter and recurse infinitely. Only the shadow (and
      // a genuinely distinct fkColumn) may be read after injection.
      const readFk = (): any => {
        const shadow = instance[fkShadow];
        if (shadow !== undefined && shadow !== null) return shadow;
        return fkColumn !== rel.columnName ? instance[fkColumn] : undefined;
      };

      injectLazyProxy(instance, rel.columnName, async () => {
        let fk = fkValue ?? readFk();
        if ((fk === undefined || fk === null) && hydrateStub) {
          await hydrateStub();
          fk = readFk();
        }
        if (fk === undefined || fk === null) return undefined;
        const result = await this.ctx.em.findOne(RelatedEntity, {
          where: { [refColumn]: fk } as any,
        });
        if (result) return this.resolveIdentity(RelatedEntity, result);
        return undefined;
      });
    }
  }

  /**
   * @OneToMany lazy: access `instance.comments` -> loads Comment[] by FK.
   */
  private injectLazyOneToMany(instance: EntityInstance, entityClass: ClazzType<any>): void {
    const meta: OneToManyMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_MANY_TOKEN, entityClass) ?? [];

    for (const rel of meta) {
      if (isRelationOccupied(instance, rel.propertyKey)) continue;

      const ChildEntity = rel.getRelatedEntity();
      try { this.idMap.validateEntity(ChildEntity); } catch { continue; }

      const fkColumn = resolveFkColumn(rel, ChildEntity);
      const parentPk = this.idMap.getParentPkValue(instance, entityClass);
      if (parentPk === undefined || parentPk === null) continue;

      this.injectLazyCollectionProxy(instance, rel.propertyKey, ChildEntity, {
        [fkColumn]: parentPk,
      });
    }
  }

  /**
   * @OneToOne lazy: access `instance.profile` -> loads Profile by FK or inverse lookup.
   */
  private injectLazyOneToOne(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
    hydrateStub?: () => Promise<void>,
  ): void {
    const meta: OneToOneMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ?? [];

    for (const rel of meta) {
      if (isRelationOccupied(instance, rel.propertyKey)) continue;

      const RelatedEntity = rel.getRelatedEntity();
      try { this.idMap.validateEntity(RelatedEntity); } catch { continue; }

      if (rel.joinColumn) {
        // Owning side - FK column on this entity
        const joinColumn = rel.joinColumn;
        const fkValue = instance[joinColumn];
        // A PK-only stub has no FK yet — inject anyway when it can hydrate
        // itself on first access.
        if ((fkValue === undefined || fkValue === null) && !hydrateStub) continue;

        const relatedPkCols = this.idMap.getColumnInfo(RelatedEntity).pkColumns;
        if (relatedPkCols.length !== 1) continue;

        injectLazyProxy(instance, rel.propertyKey, async () => {
          let fk = instance[joinColumn];
          if ((fk === undefined || fk === null) && hydrateStub) {
            await hydrateStub();
            fk = instance[joinColumn];
          }
          if (fk === undefined || fk === null) return undefined;
          const result = await this.ctx.em.findOne(RelatedEntity, {
            where: { [relatedPkCols[0]]: fk } as any,
          });
          if (result) return this.resolveIdentity(RelatedEntity, result);
          return undefined;
        });
      } else if (rel.inverseSide) {
        // Inverse side - find where owning side references our PK
        const parentPk = this.idMap.getParentPkValue(instance, entityClass);
        if (parentPk === undefined || parentPk === null) continue;

        const owningMeta: OneToOneMetadata<any>[] =
          Reflect.getMetadata(ONE_TO_ONE_TOKEN, RelatedEntity) ?? [];
        const owningRel = owningMeta.find(
          (r) => r.propertyKey === rel.inverseSide,
        );
        if (!owningRel?.joinColumn) continue;

        injectLazyProxy(instance, rel.propertyKey, async () => {
          const result = await this.ctx.em.findOne(RelatedEntity, {
            where: { [owningRel.joinColumn!]: parentPk } as any,
          });
          if (result) return this.resolveIdentity(RelatedEntity, result);
          return undefined;
        });
      }
    }
  }

  /**
   * @ManyToMany lazy: access `instance.tags` -> queries pivot table + loads related entities.
   *
   * Fixed N+1: uses batched IN query instead of loading entities one by one.
   */
  private injectLazyManyToMany(instance: EntityInstance, entityClass: ClazzType<any>): void {
    const meta: ManyToManyMetadata<any>[] =
      Reflect.getMetadata(MANY_TO_MANY_TOKEN, entityClass) ?? [];

    for (const rel of meta) {
      if (isRelationOccupied(instance, rel.propertyKey)) continue;

      const RelatedEntity = rel.getRelatedEntity();
      try { this.idMap.validateEntity(RelatedEntity); } catch { continue; }

      const parentPk = this.idMap.getParentPkValue(instance, entityClass);
      if (parentPk === undefined || parentPk === null) continue;

      let tableName: string;
      let joinColumn: string;
      let inverseJoinColumn: string;

      if (rel.joinTable) {
        // Owning side
        tableName = rel.joinTable.name;
        joinColumn = rel.joinTable.joinColumn;
        inverseJoinColumn = rel.joinTable.inverseJoinColumn;
      } else if (rel.mappedBy) {
        // Inverse side - look up owning side's joinTable
        const owningMeta: ManyToManyMetadata<any>[] =
          Reflect.getMetadata(MANY_TO_MANY_TOKEN, RelatedEntity) ?? [];
        const owningRel = owningMeta.find(
          (r) => r.propertyKey === rel.mappedBy,
        );
        if (!owningRel?.joinTable) continue;
        // Swap columns for inverse side
        tableName = owningRel.joinTable.name;
        joinColumn = owningRel.joinTable.inverseJoinColumn;
        inverseJoinColumn = owningRel.joinTable.joinColumn;
      } else {
        continue;
      }

      this.injectLazyM2MProxy(
        instance, rel.propertyKey, RelatedEntity,
        tableName, joinColumn, inverseJoinColumn, parentPk,
      );
    }
  }

  /**
   * Inject a lazy collection proxy (for O2M).
   * First access returns a Promise<T[]>; after resolution, the property
   * holds the actual array.
   */
  private injectLazyCollectionProxy(
    instance: EntityInstance,
    propertyKey: string,
    ChildEntity: ClazzType<any>,
    where: Record<string, any>,
  ): void {
    let loaded = false;
    let cachedValue: any[] | undefined;
    let loadPromise: Promise<any[] | undefined> | null = null;

    Object.defineProperty(instance, propertyKey, {
      configurable: true,
      // Non-enumerable while unloaded — see injectLazyProxy. Materializing or
      // setting promotes the property to an enumerable own value.
      enumerable: false,
      get: () => {
        if (loaded) return cachedValue;
        // Reuse the in-flight load so concurrent accesses issue one query
        if (!loadPromise) {
          loadPromise = this.ctx.em.find(ChildEntity, { where: where as any })
            .then(
              (results) => {
                loadPromise = null;
                // A setter may have run while the load was in flight — keep its value
                if (loaded) return cachedValue;
                cachedValue = results.map((r) => this.resolveIdentity(ChildEntity, r));
                loaded = true;
                Object.defineProperty(instance, propertyKey, {
                  configurable: true, enumerable: true, writable: true,
                  value: cachedValue,
                });
                this.onCollectionMaterialized?.(instance, propertyKey);
                return cachedValue;
              },
              (err) => {
                // Clear the in-flight slot so a later access can retry
                loadPromise = null;
                throw err;
              },
            );
          suppressUnhandledRejection(loadPromise);
        }
        return loadPromise;
      },
      set: (value: any) => {
        loaded = true;
        cachedValue = value;
        Object.defineProperty(instance, propertyKey, {
          configurable: true, enumerable: true, writable: true, value,
        });
      },
    });
  }

  /**
   * Inject a lazy M2M proxy that queries the pivot table + loads entities.
   *
   * Fixed N+1: uses a single batched find() with array WHERE instead of
   * N individual findOne() calls.
   */
  private injectLazyM2MProxy(
    instance: EntityInstance,
    propertyKey: string,
    RelatedEntity: ClazzType<any>,
    tableName: string,
    joinColumn: string,
    inverseJoinColumn: string,
    parentPk: any,
  ): void {
    let loaded = false;
    let cachedValue: any[] | undefined;
    let loadPromise: Promise<any[]> | null = null;

    Object.defineProperty(instance, propertyKey, {
      configurable: true,
      // Non-enumerable while unloaded — see injectLazyProxy. Materializing or
      // setting promotes the property to an enumerable own value.
      enumerable: false,
      get: () => {
        if (loaded) return cachedValue;
        if (loadPromise) return loadPromise;

        const relatedPkCols = this.idMap.getColumnInfo(RelatedEntity).pkColumns;
        if (relatedPkCols.length !== 1) {
          loaded = true;
          cachedValue = [];
          return [];
        }

        const wrappedTable = this.ctx.wrapTable(tableName);
        const wrappedJoinCol = this.ctx.wrap(joinColumn);
        const wrappedInverseCol = this.ctx.wrap(inverseJoinColumn);
        const relatedPk = relatedPkCols[0];

        loadPromise = this.ctx.em.query(
          `SELECT ${wrappedInverseCol} FROM ${wrappedTable} WHERE ${wrappedJoinCol} = ?`,
          [parentPk],
        ).then(async (rows: any[]) => {
          const ids = rows.map((r: any) => r[inverseJoinColumn]);
          if (ids.length === 0) {
            loadPromise = null;
            if (loaded) return cachedValue ?? [];
            cachedValue = [];
            loaded = true;
            Object.defineProperty(instance, propertyKey, {
              configurable: true, enumerable: true, writable: true, value: [],
            });
            this.onCollectionMaterialized?.(instance, propertyKey);
            return [];
          }

          // Batched IN query instead of N+1 individual findOne() calls
          const results = await this.ctx.em.find(RelatedEntity, {
            where: { [relatedPk]: ids } as any,
          });
          const resolvedResults = results.map((r) => this.resolveIdentity(RelatedEntity, r));

          loadPromise = null;
          // A setter may have run while the load was in flight — keep its value
          if (loaded) return cachedValue ?? [];
          cachedValue = resolvedResults;
          loaded = true;
          Object.defineProperty(instance, propertyKey, {
            configurable: true, enumerable: true, writable: true, value: resolvedResults,
          });
          this.onCollectionMaterialized?.(instance, propertyKey);
          return resolvedResults;
        }).catch((err) => {
          // Clear the in-flight slot so a later access can retry. `.catch`
          // (not a second .then argument) because the fulfilled callback is
          // async — its own await can reject too.
          loadPromise = null;
          throw err;
        });
        suppressUnhandledRejection(loadPromise);
        return loadPromise;
      },
      set: (value: any) => {
        loaded = true;
        cachedValue = value;
        Object.defineProperty(instance, propertyKey, {
          configurable: true, enumerable: true, writable: true, value,
        });
      },
    });
  }
}
