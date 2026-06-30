/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { WhereClause } from "../dialects/FindOption";
import { HOOK_TOKEN, HookEvent, HookMetadata } from "../decorators";
import { hasCascade } from "../types/CascadeType";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";

/**
 * Handler for cascade save/delete operations and lifecycle hooks.
 * Invoked on behalf of EntityManager.
 */
export class CascadeHandler {
  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
  ) {}

  /**
   * Runs the lifecycle hooks bound to the given event on the entity instance.
   * Reads @HOOK_TOKEN metadata and invokes the method registered for that event.
   */
  async runHooks<T>(
    entity: ClazzType<T>,
    item: Partial<T> | WhereClause<T>,
    event: HookEvent,
  ): Promise<void> {
    const hooks = Reflect.getMetadata(HOOK_TOKEN, entity) as
      | HookMetadata[]
      | undefined;
    if (!hooks || hooks.length === 0) return;

    for (const hook of hooks) {
      if (hook.event !== event) continue;
      const method = (item as any)[hook.methodName];
      if (typeof method === "function") {
        // Pass `item` both as `this` and as the first argument. Decorator hook
        // methods read `this` and ignore the extra arg; decorator-free hook
        // functions (defineEntity `hooks: { beforeInsert: (e) => … }`) can take
        // the entity as a parameter instead of relying on `this`.
        await method.call(item, item);
      }
    }
  }

  /**
   * Creates a Proxy that tracks mutations for change detection.
   */
  createProxy<T>(entity: T): T {
    return new Proxy(entity as any, {
      set: (target: any, prop: string, value: any) => {
        target[prop] = value;

        // Add the mutated entity to the dirty Set.
        this.ctx.markDirty(target);
        return true;
      },
    });
  }

  /**
   * On save, recursively persists child entities of OneToMany relations whose cascade includes "insert" | "update".
   */
  async cascadeSaveOneToMany<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
    savedParentId: any,
    session?: TransactionSessionManager,
  ): Promise<void> {
    const oneToManyMeta = this.resolver.resolveOneToManyMetadata(entity);

    for (const rel of oneToManyMeta) {
      const children = (item as any)[rel.propertyKey];
      if (!children || !Array.isArray(children) || children.length === 0)
        continue;

      const RelatedEntity = rel.getRelatedEntity();

      // Only proceed when cascade includes "insert" or "update".
      if (
        !hasCascade(rel.cascade, "insert") &&
        !hasCascade(rel.cascade, "update")
      )
        continue;

      // Find the joinColumn on the ManyToOne side.
      const manyToOneItems = this.resolver.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;

      // The child's INSERT/UPDATE path resolves the FK value from the relation
      // object, the `${prop}Id` shadow accessor, or an explicit
      // `option.fkProperty` — never from the raw joinColumn DB name. When the FK
      // is declared via `@RelationColumn({ name })` with no backing `@Column`
      // (the documented nestjs-blog pattern), writing only `child[joinColumn]`
      // (e.g. `child["author_id"]`) left the FK unwritten — the cascade-inserted
      // child got a NULL/omitted FK. Also set the shadow (and fkProperty, if
      // configured) so the FK is actually persisted, while keeping the raw
      // assignment for the legacy backing-`@Column` (column name == property
      // key) setup.
      const shadowKey = matchingRelation
        ? `${matchingRelation.columnName}Id`
        : undefined;
      const fkPropertyKey = matchingRelation?.option?.fkProperty;

      for (const child of children) {
        // Set the FK to the parent's PK.
        (child as any)[fkColumn] = savedParentId;
        if (shadowKey) (child as any)[shadowKey] = savedParentId;
        if (fkPropertyKey) (child as any)[fkPropertyKey] = savedParentId;
        if (session) {
          await this.ctx.saveWithSession(RelatedEntity, child, session);
        } else {
          await this.ctx.save(RelatedEntity, child);
        }
      }
    }
  }

  /**
   * On save, persists the parent entity of ManyToOne relations whose cascade includes "insert" | "update" first.
   */
  async cascadeSaveManyToOne<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<void> {
    const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);

    for (const rel of manyToOneRelations) {
      const relatedValue = (item as any)[rel.columnName];
      if (!relatedValue || typeof relatedValue !== "object") continue;

      if (
        !hasCascade(rel.option?.cascade, "insert") &&
        !hasCascade(rel.option?.cascade, "update")
      )
        continue;

      const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
      const saved = await this.ctx.save(RelatedEntity, relatedValue);

      // Assign the saved parent's PK to the FK column.
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) {
        throw new EntityMetadataNotFoundError(RelatedEntity.name);
      }
      const relatedPk = relatedMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (relatedPk && rel.joinColumn) {
        (item as any)[rel.joinColumn] = (saved as any)[relatedPk.propertyKey ?? relatedPk.name!];
      }
    }
  }

  /**
   * On delete, first removes child entities of OneToMany relations whose cascade includes "delete" (or "remove").
   * Optimized by selecting only PKs and issuing a batched DELETE via IN to save memory and query round-trips.
   */
  async cascadeDeleteOneToMany<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<void> {
    const oneToManyMeta = this.resolver.resolveOneToManyMetadata(entity);

    for (const rel of oneToManyMeta) {
      if (!hasCascade(rel.cascade, "delete")) continue;

      const RelatedEntity = rel.getRelatedEntity();

      // Query the parents being deleted to collect their PKs.
      const parentMetadata = this.resolver.resolveEntityMetadata(entity);
      if (!parentMetadata) continue;

      const pk = parentMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (!pk) continue;

      // SELECT only the PK to conserve memory.
      const parents = await this.ctx.find(entity, {
        where: criteria,
        select: { [pk.name!]: true },
      } as any);

      if (!parents) continue;

      const parentArray = Array.isArray(parents) ? parents : [parents];

      // Collect parent PKs.
      const parentIds = parentArray
        .map((p: any) => p[pk.propertyKey ?? pk.name!])
        .filter((id: any) => id !== undefined && id !== null);

      if (parentIds.length === 0) continue;

      // Find the FK column on the ManyToOne side.
      const manyToOneItems = this.resolver.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;

      // Delete all children in a single IN clause.
      if (parentIds.length === 1) {
        await this.ctx.delete(RelatedEntity, {
          [fkColumn]: parentIds[0],
        } as any);
      } else {
        await this.ctx.delete(RelatedEntity, {
          [fkColumn]: parentIds,
        } as any);
      }
    }
  }
}
