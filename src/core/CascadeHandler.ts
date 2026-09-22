/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { WhereClause } from "../dialects/FindOption";
import { HOOK_TOKEN, HookEvent, HookMetadata } from "../decorators";
import { hasCascade } from "../types/CascadeType";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { runScopeExempt } from "./entity-manager/scope-exemption";
import {
  assignFkValue,
  fkWriteKeysFromManyToOne,
} from "./plugin/buffer/CollectionTracker";

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
   *
   * Runs scope-exempt: the child saves go through the public `ctx.save`
   * facade (kept so test spies / plugin wrappers observe them), but a cascade
   * target may legitimately sit outside a scoped EM's `entities` array.
   */
  async cascadeSaveOneToMany<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
    savedParentId: any,
    session?: TransactionSessionManager,
  ): Promise<void> {
    return runScopeExempt(() =>
      this.cascadeSaveOneToManyInner(entity, item, savedParentId, session),
    );
  }

  private async cascadeSaveOneToManyInner<T>(
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

      // The child's INSERT/UPDATE path resolves the FK value from the relation
      // object, the `${prop}Id` shadow accessor, or an explicit
      // `option.fkProperty` — never from the raw joinColumn DB name, so the
      // shadow (and fkProperty, if configured) must be written alongside the
      // raw column. Key derivation and assignment are shared with the
      // WriteBuffer cascade (CollectionTracker) so both paths stay in
      // lockstep; only the metadata lookup above stays resolver-based here.
      const fkKeys = fkWriteKeysFromManyToOne(matchingRelation, rel.mappedBy);

      for (const child of children) {
        // Set the FK to the parent's PK.
        assignFkValue(child, fkKeys, savedParentId);
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
   * Runs scope-exempt — see {@link cascadeSaveOneToMany}.
   */
  async cascadeSaveManyToOne<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<void> {
    return runScopeExempt(() => this.cascadeSaveManyToOneInner(entity, item));
  }

  private async cascadeSaveManyToOneInner<T>(
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
        (item as any)[rel.joinColumn] = (saved as any)[relatedPk.propertyKey ?? relatedPk.name];
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
    // Scope-exempt — see cascadeSaveOneToMany.
    return runScopeExempt(() =>
      this.cascadeRemoveOneToMany(entity, criteria, "delete"),
    );
  }

  /**
   * On softDelete, first trashes the children of OneToMany relations whose
   * cascade includes "delete" (or "remove") — the soft-delete counterpart of
   * {@link cascadeDeleteOneToMany}. A child entity without `@DeletedAt` has no
   * soft-delete to cascade to and is skipped; `cascade: ["remove"]` only hard
   * deletes it under `delete()`.
   */
  async cascadeSoftDeleteOneToMany<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<void> {
    return runScopeExempt(() =>
      this.cascadeRemoveOneToMany(entity, criteria, "softDelete"),
    );
  }

  /**
   * On restore, revives the children the parent's softDelete cascaded to —
   * the inverse of {@link cascadeSoftDeleteOneToMany}. Only children of
   * parents that are currently soft-deleted are touched, so restoring a
   * criteria that also matches live parents does not revive children those
   * parents trashed on their own.
   */
  async cascadeRestoreOneToMany<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<void> {
    return runScopeExempt(() =>
      this.cascadeRemoveOneToMany(entity, criteria, "restore"),
    );
  }

  /**
   * The shared cascade of the three removal operations: resolve the parents
   * the criteria names (PK only — the child statement is one `WHERE fk IN
   * (...)` per relation), then issue the same operation on each cascading
   * OneToMany's children through the public ctx method, which cascades
   * further down and fires the child's own events.
   *
   * Parent lookup per mode: `delete` and `softDelete` act on live parents —
   * the parent statement that follows only touches those; `restore` reads
   * `withDeleted` and keeps the soft-deleted parents, since a default read
   * would return none of the rows being restored.
   */
  private async cascadeRemoveOneToMany<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
    mode: "delete" | "softDelete" | "restore",
  ): Promise<void> {
    const oneToManyMeta = this.resolver.resolveOneToManyMetadata(entity);

    for (const rel of oneToManyMeta) {
      if (!hasCascade(rel.cascade, "delete")) continue;

      const RelatedEntity = rel.getRelatedEntity();

      // A soft-delete cascade needs a soft-deletable child.
      if (mode !== "delete" && !this.resolver.getDeletedAtColumn(RelatedEntity)) {
        continue;
      }

      // Query the parents being removed to collect their PKs.
      const parentMetadata = this.resolver.resolveEntityMetadata(entity);
      if (!parentMetadata) continue;

      const pk = parentMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (!pk) continue;

      const pkProperty = pk.propertyKey ?? pk.name;
      const parentDeletedAt =
        mode === "restore" ? this.resolver.getDeletedAtColumn(entity) : null;

      // SELECT only the PK (and, for restore, the soft-delete stamp) to
      // conserve memory.
      const parents = await this.ctx.find(entity, {
        where: criteria,
        select: {
          [pk.name]: true,
          ...(parentDeletedAt ? { [parentDeletedAt]: true } : {}),
        },
        ...(mode === "restore" ? { withDeleted: true } : {}),
      } as any);

      if (!parents) continue;

      const parentArray = Array.isArray(parents) ? parents : [parents];

      // Collect parent PKs — on restore, only of the parents being revived.
      const parentIds = parentArray
        .filter(
          (p: any) =>
            !parentDeletedAt ||
            (p[parentDeletedAt] !== undefined && p[parentDeletedAt] !== null),
        )
        .map((p: any) => p[pkProperty])
        .filter((id: any) => id !== undefined && id !== null);

      if (parentIds.length === 0) continue;

      // Find the FK column on the ManyToOne side.
      const manyToOneItems = this.resolver.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;

      // One statement for every child: `fk = ?` or `fk IN (...)`.
      const childCriteria = {
        [fkColumn]: parentIds.length === 1 ? parentIds[0] : parentIds,
      } as any;
      if (mode === "delete") {
        await this.ctx.delete(RelatedEntity, childCriteria);
      } else if (mode === "softDelete") {
        await this.ctx.softDelete(RelatedEntity, childCriteria);
      } else {
        await this.ctx.restore(RelatedEntity, childCriteria);
      }
    }
  }
}
