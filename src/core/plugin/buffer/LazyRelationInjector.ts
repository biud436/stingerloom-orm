/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { MANY_TO_ONE_TOKEN } from "../../../decorators/ManyToOne";
import { ONE_TO_MANY_TOKEN, OneToManyMetadata } from "../../../decorators/OneToMany";
import { ONE_TO_ONE_TOKEN } from "../../../decorators/OneToOne";
import { MANY_TO_MANY_TOKEN } from "../../../decorators/ManyToMany";
import { PluginContext } from "../PluginContext";
import { IdentityMapManager, EntityInstance } from "./IdentityMapManager";
import { resolveFkColumn } from "./CollectionTracker";
import { injectLazyProxy } from "../../LazyLoader";
import type { ManyToOneMetadata } from "../../../decorators/ManyToOne";
import type { OneToOneMetadata } from "../../../decorators/OneToOne";
import type { ManyToManyMetadata } from "../../../decorators/ManyToMany";

/**
 * Callback to resolve identity map membership for loaded entities.
 * Returns the existing tracked instance if one exists, otherwise tracks the new one.
 */
export type ResolveIdentityFn = (entityClass: ClazzType<any>, instance: EntityInstance) => EntityInstance;

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

  constructor(
    ctx: PluginContext,
    idMap: IdentityMapManager,
    resolveIdentity: ResolveIdentityFn,
  ) {
    this.ctx = ctx;
    this.idMap = idMap;
    this.resolveIdentity = resolveIdentity;
  }

  /**
   * Inject lazy-loading proxies on all relation properties of an instance.
   */
  injectLazyRelations(instance: EntityInstance, entityClass: ClazzType<any>): void {
    this.injectLazyManyToOne(instance, entityClass);
    this.injectLazyOneToMany(instance, entityClass);
    this.injectLazyOneToOne(instance, entityClass);
    this.injectLazyManyToMany(instance, entityClass);
  }

  /**
   * @ManyToOne lazy: access `instance.author` -> loads Author by FK value.
   */
  private injectLazyManyToOne(instance: EntityInstance, entityClass: ClazzType<any>): void {
    const meta: ManyToOneMetadata<any>[] =
      Reflect.getMetadata(MANY_TO_ONE_TOKEN, entityClass) ?? [];

    for (const rel of meta) {
      // Skip if already loaded (not undefined)
      if (instance[rel.columnName] !== undefined) continue;

      // FK column: explicit joinColumn or fallback to columnName
      const fkProp = rel.joinColumn ?? rel.columnName;
      const fkValue = instance[fkProp];
      if (fkValue === undefined || fkValue === null) continue;

      const RelatedEntity = rel.getMappingEntity() as any as ClazzType<any>;
      try { this.idMap.validateEntity(RelatedEntity); } catch { continue; }

      const relatedPkCols = this.idMap.getColumnInfo(RelatedEntity).pkColumns;
      const refColumn = rel.references ?? (relatedPkCols.length === 1 ? relatedPkCols[0] : null);
      if (!refColumn) continue;

      injectLazyProxy(instance, rel.columnName, async () => {
        const result = await this.ctx.em.findOne(RelatedEntity, {
          where: { [refColumn]: fkValue } as any,
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
      if (instance[rel.propertyKey] !== undefined) continue;

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
  private injectLazyOneToOne(instance: EntityInstance, entityClass: ClazzType<any>): void {
    const meta: OneToOneMetadata<any>[] =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ?? [];

    for (const rel of meta) {
      if (instance[rel.propertyKey] !== undefined) continue;

      const RelatedEntity = rel.getRelatedEntity();
      try { this.idMap.validateEntity(RelatedEntity); } catch { continue; }

      if (rel.joinColumn) {
        // Owning side - FK column on this entity
        const fkValue = instance[rel.joinColumn];
        if (fkValue === undefined || fkValue === null) continue;

        const relatedPkCols = this.idMap.getColumnInfo(RelatedEntity).pkColumns;
        if (relatedPkCols.length !== 1) continue;

        injectLazyProxy(instance, rel.propertyKey, async () => {
          const result = await this.ctx.em.findOne(RelatedEntity, {
            where: { [relatedPkCols[0]]: fkValue } as any,
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
      if (instance[rel.propertyKey] !== undefined) continue;

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

    Object.defineProperty(instance, propertyKey, {
      configurable: true,
      enumerable: true,
      get: () => {
        if (loaded) return cachedValue;
        const promise = this.ctx.em.find(ChildEntity, { where: where as any })
          .then((results) => {
            cachedValue = results.map((r) => this.resolveIdentity(ChildEntity, r));
            loaded = true;
            Object.defineProperty(instance, propertyKey, {
              configurable: true, enumerable: true, writable: true,
              value: cachedValue,
            });
            return cachedValue;
          });
        return promise;
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

    Object.defineProperty(instance, propertyKey, {
      configurable: true,
      enumerable: true,
      get: () => {
        if (loaded) return cachedValue;

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

        const promise = this.ctx.em.query(
          `SELECT ${wrappedInverseCol} FROM ${wrappedTable} WHERE ${wrappedJoinCol} = ?`,
          [parentPk],
        ).then(async (rows: any[]) => {
          const ids = rows.map((r: any) => r[inverseJoinColumn]);
          if (ids.length === 0) {
            cachedValue = [];
            loaded = true;
            Object.defineProperty(instance, propertyKey, {
              configurable: true, enumerable: true, writable: true, value: [],
            });
            return [];
          }

          // Batched IN query instead of N+1 individual findOne() calls
          const results = await this.ctx.em.find(RelatedEntity, {
            where: { [relatedPk]: ids } as any,
          });
          const resolvedResults = results.map((r) => this.resolveIdentity(RelatedEntity, r));

          cachedValue = resolvedResults;
          loaded = true;
          Object.defineProperty(instance, propertyKey, {
            configurable: true, enumerable: true, writable: true, value: resolvedResults,
          });
          return resolvedResults;
        });
        return promise;
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
