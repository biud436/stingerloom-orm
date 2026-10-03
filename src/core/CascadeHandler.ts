/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from "node:async_hooks";
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
 * What a hard delete still has to do once the parent rows are gone: remove
 * the targets of the cascading owning-side OneToOne relations, whose rows
 * the deleted parents referenced and so could not be deleted before them.
 */
export type AfterParentDelete = () => Promise<void>;

/**
 * A relation whose rows hold the parent's key and so follow the parent
 * through a removal: a OneToMany, or the inverse side of a OneToOne.
 */
interface DependentRelation {
  RelatedEntity: ClazzType<any>;
  /** The join column on the related table that holds the parent's key. */
  fkColumn: string;
}

/**
 * The objects whose save started the cascade the current call runs in,
 * outermost first. An object graph can point back at an ancestor —
 * `user.profile.user === user` with `cascade` on both sides, or a post in
 * `owner.posts` whose `user` is the owner — and following that edge saved
 * the ancestor again, which cascaded to the child again, without end. An
 * object already on the chain is being saved by a caller up the stack, so
 * the cascade leaves it to that caller.
 */
const cascadeChain = new AsyncLocalStorage<ReadonlySet<object>>();

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
   * On save, recursively persists the dependents of the saved row whose
   * cascade includes "insert" | "update": the children of each OneToMany
   * and the entity on the inverse side of each OneToOne. Each gets the
   * parent's key in its join column first.
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
    return CascadeHandler.withinChain(item, () =>
      runScopeExempt(() =>
        this.cascadeSaveOneToManyInner(entity, item, savedParentId, session),
      ),
    );
  }

  /** Runs `run` with `item` added to the cascade chain — see {@link cascadeChain}. */
  private static withinChain<R>(item: unknown, run: () => Promise<R>): Promise<R> {
    if (!item || typeof item !== "object") return run();
    const current = cascadeChain.getStore();
    if (current?.has(item)) return run();
    const next = new Set(current ?? []);
    next.add(item);
    return cascadeChain.run(next, run);
  }

  /** Whether `value` is being saved by a caller up the cascade. */
  private static isAncestor(value: unknown): boolean {
    return !!value && typeof value === "object" && cascadeChain.getStore()?.has(value) === true;
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
        if (CascadeHandler.isAncestor(child)) continue;
        // Set the FK to the parent's PK.
        assignFkValue(child, fkKeys, savedParentId);
        if (session) {
          await this.ctx.saveWithSession(RelatedEntity, child, session);
        } else {
          await this.ctx.save(RelatedEntity, child);
        }
      }
    }

    // Inverse-side OneToOne: the counterpart holds the key, like a child.
    for (const rel of this.resolver.resolveOneToOneMetadata(entity)) {
      if (rel.joinColumn || !rel.inverseSide) continue;
      if (
        !hasCascade(rel.option?.cascade, "insert") &&
        !hasCascade(rel.option?.cascade, "update")
      )
        continue;
      const counterpart = (item as any)[rel.propertyKey];
      if (!counterpart || typeof counterpart !== "object") continue;
      if (CascadeHandler.isAncestor(counterpart)) continue;

      const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
      const owner = this.owningOneToOneFor(RelatedEntity, rel.inverseSide);
      if (!owner?.joinColumn) continue;

      assignFkValue(
        counterpart,
        {
          fkColumn: owner.joinColumn,
          shadowKey: `${owner.propertyKey}Id`,
          fkPropertyKey: owner.option?.fkProperty,
        },
        savedParentId,
      );
      if (session) {
        await this.ctx.saveWithSession(RelatedEntity, counterpart, session);
      } else {
        await this.ctx.save(RelatedEntity, counterpart);
      }
    }
  }

  /** The owning-side OneToOne of `entity` named `propertyKey`, if declared. */
  private owningOneToOneFor(entity: ClazzType<any>, propertyKey: string) {
    return this.resolver
      .resolveOneToOneMetadata(entity)
      .find((r) => r.propertyKey === propertyKey && !!r.joinColumn);
  }

  /**
   * On save, first persists the entities the row references whose cascade
   * includes "insert" | "update": the target of each ManyToOne and of each
   * owning-side OneToOne, so their keys exist before the row's join columns
   * are written. Runs scope-exempt — see {@link cascadeSaveOneToMany}.
   */
  async cascadeSaveManyToOne<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<void> {
    return CascadeHandler.withinChain(item, () =>
      runScopeExempt(() => this.cascadeSaveManyToOneInner(entity, item)),
    );
  }

  private async cascadeSaveManyToOneInner<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<void> {
    const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);

    for (const rel of manyToOneRelations) {
      const relatedValue = (item as any)[rel.columnName];
      if (!relatedValue || typeof relatedValue !== "object") continue;
      // The parent is being saved up the stack; it writes this row's key
      // through its own cascade.
      if (CascadeHandler.isAncestor(relatedValue)) continue;

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

    // Owning-side OneToOne: the row's join column takes the saved target's
    // key, read from the target instance the row still holds.
    for (const rel of this.resolver.resolveOneToOneMetadata(entity)) {
      if (!rel.joinColumn) continue;
      if (
        !hasCascade(rel.option?.cascade, "insert") &&
        !hasCascade(rel.option?.cascade, "update")
      )
        continue;
      const target = (item as any)[rel.propertyKey];
      if (!target || typeof target !== "object") continue;
      if (CascadeHandler.isAncestor(target)) continue;

      const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
      const saved = await this.ctx.save(RelatedEntity, target);
      const relatedPk = this.resolver
        .resolveEntityMetadata(RelatedEntity)
        ?.columns.find((col: any) => col.options?.primary);
      if (relatedPk) {
        const key = relatedPk.propertyKey ?? relatedPk.name;
        if (target[key] === undefined || target[key] === null) {
          target[key] = (saved as any)[key];
        }
      }
    }
  }

  /**
   * On delete, first removes the dependents whose cascade includes "delete"
   * (or "remove") — OneToMany children and inverse-side OneToOne
   * counterparts — selecting only parent PKs and issuing one batched DELETE
   * per relation.
   *
   * The targets of cascading owning-side OneToOne relations are referenced
   * by the parent rows and can only go once those are deleted: their keys
   * are read here and the returned {@link AfterParentDelete} deletes them —
   * the caller runs it right after the parent statement. Undefined when no
   * such relation applies.
   */
  async cascadeDeleteOneToMany<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<AfterParentDelete | undefined> {
    // Scope-exempt — see cascadeSaveOneToMany.
    return runScopeExempt(async () => {
      await this.cascadeRemoveOneToMany(entity, criteria, "delete");
      const owned = await this.collectOwnedTargets(entity, criteria, "delete");
      if (owned.length === 0) return undefined;
      return () =>
        runScopeExempt(async () => {
          for (const { RelatedEntity, pkProperty, ids } of owned) {
            await this.ctx.delete(RelatedEntity, { [pkProperty]: ids.length === 1 ? ids[0] : ids } as any);
          }
        });
    });
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
    return runScopeExempt(async () => {
      await this.cascadeRemoveOneToMany(entity, criteria, "softDelete");
      await this.removeOwnedTargets(entity, criteria, "softDelete");
    });
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
    return runScopeExempt(async () => {
      await this.cascadeRemoveOneToMany(entity, criteria, "restore");
      await this.removeOwnedTargets(entity, criteria, "restore");
    });
  }

  /**
   * The shared cascade of the three removal operations over the parent's
   * dependents (see {@link cascadingDependents}): resolve the parents the
   * criteria names (PK only — see {@link removedParentIds}), then issue the
   * same operation on every dependent with one `WHERE fk IN (...)` per
   * relation, through the public ctx method, which cascades further down and
   * fires the dependent's own events.
   */
  private async cascadeRemoveOneToMany<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
    mode: "delete" | "softDelete" | "restore",
  ): Promise<void> {
    // A soft-delete cascade needs a soft-deletable dependent.
    const dependents = this.cascadingDependents(entity).filter(
      (dep) => mode === "delete" || !!this.resolver.getDeletedAtColumn(dep.RelatedEntity),
    );
    if (dependents.length === 0) return;

    const parentIds = await this.removedParentIds(entity, criteria, mode);
    if (parentIds.length === 0) return;

    for (const { RelatedEntity, fkColumn } of dependents) {
      // One statement for every dependent: `fk = ?` or `fk IN (...)`.
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

  /**
   * The relations whose rows hold the parent's key and cascade its removal:
   * every OneToMany and every inverse-side OneToOne with a "delete" cascade.
   */
  private cascadingDependents(entity: ClazzType<any>): DependentRelation[] {
    const dependents: DependentRelation[] = [];
    for (const rel of this.resolver.resolveOneToManyMetadata(entity)) {
      if (!hasCascade(rel.cascade, "delete")) continue;
      const RelatedEntity = rel.getRelatedEntity();
      const matchingRelation = this.resolver
        .resolveManyToOneMetadata(RelatedEntity)
        .find((m) => m.columnName === rel.mappedBy);
      dependents.push({
        RelatedEntity,
        fkColumn: matchingRelation?.joinColumn ?? rel.mappedBy,
      });
    }
    for (const rel of this.resolver.resolveOneToOneMetadata(entity)) {
      if (rel.joinColumn || !rel.inverseSide) continue;
      if (!hasCascade(rel.option?.cascade, "delete")) continue;
      const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
      const owner = this.owningOneToOneFor(RelatedEntity, rel.inverseSide);
      if (!owner?.joinColumn) continue;
      dependents.push({ RelatedEntity, fkColumn: owner.joinColumn });
    }
    return dependents;
  }

  /**
   * Whether the parent read of a removal includes soft-deleted rows: a hard
   * `delete` removes a trashed parent too, so its dependents must go with
   * it (a default read skipped them and left them orphaned); `restore` acts
   * on trashed parents only; `softDelete` acts on live ones.
   */
  private static readsTrashedParents(mode: "delete" | "softDelete" | "restore"): boolean {
    return mode !== "softDelete";
  }

  /**
   * The PKs of the parents a removal acts on. `softDelete` acts on live
   * parents — the parent statement that follows only touches those; `delete`
   * reads `withDeleted` because the hard delete removes trashed rows as
   * well; `restore` reads `withDeleted` and keeps the soft-deleted parents,
   * since a default read would return none of the rows being restored.
   */
  private async removedParentIds<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
    mode: "delete" | "softDelete" | "restore",
  ): Promise<unknown[]> {
    const parentMetadata = this.resolver.resolveEntityMetadata(entity);
    const pk = parentMetadata?.columns.find((col: any) => col.options?.primary);
    if (!pk) return [];

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
      ...(CascadeHandler.readsTrashedParents(mode) ? { withDeleted: true } : {}),
    } as any);
    if (!parents) return [];

    const parentArray = Array.isArray(parents) ? parents : [parents];
    return parentArray
      .filter(
        (p: any) =>
          !parentDeletedAt ||
          (p[parentDeletedAt] !== undefined && p[parentDeletedAt] !== null),
      )
      .map((p: any) => p[pkProperty])
      .filter((id: any) => id !== undefined && id !== null);
  }

  /**
   * The targets of the cascading owning-side OneToOne relations of the rows
   * a removal acts on, by relation: the keys those rows hold in each join
   * column. A soft-delete cascade only reaches a soft-deletable target.
   */
  private async collectOwnedTargets<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
    mode: "delete" | "softDelete" | "restore",
  ): Promise<Array<{ RelatedEntity: ClazzType<any>; pkProperty: string; ids: unknown[] }>> {
    const owning = this.resolver.resolveOneToOneMetadata(entity).filter((rel) => {
      if (!rel.joinColumn || !hasCascade(rel.option?.cascade, "delete")) return false;
      return mode === "delete" || !!this.resolver.getDeletedAtColumn(rel.getRelatedEntity() as ClazzType<any>);
    });
    if (owning.length === 0) return [];

    const parentDeletedAt =
      mode === "restore" ? this.resolver.getDeletedAtColumn(entity) : null;
    // Only the columns read below — the key, each join column and, for
    // restore, the soft-delete stamp — like removedParentIds; reading whole
    // rows hydrated every column and fired afterLoad for a key lookup.
    const pk = this.resolver
      .resolveEntityMetadata(entity)
      ?.columns.find((col: any) => col.options?.primary);
    const select: Record<string, true> = {};
    if (pk) select[pk.name] = true;
    for (const rel of owning) select[rel.joinColumn!] = true;
    if (parentDeletedAt) select[parentDeletedAt] = true;
    const rows = await this.ctx.find(entity, {
      where: criteria,
      select,
      ...(CascadeHandler.readsTrashedParents(mode) ? { withDeleted: true } : {}),
    } as any);
    const rowArray = (Array.isArray(rows) ? rows : rows ? [rows] : []).filter(
      (row: any) =>
        !parentDeletedAt ||
        (row[parentDeletedAt] !== undefined && row[parentDeletedAt] !== null),
    );

    const owned: Array<{ RelatedEntity: ClazzType<any>; pkProperty: string; ids: unknown[] }> = [];
    for (const rel of owning) {
      const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
      const relatedPk = this.resolver
        .resolveEntityMetadata(RelatedEntity)
        ?.columns.find((col: any) => col.options?.primary);
      if (!relatedPk) continue;
      // A read row carries the key under the FK shadow (or the configured
      // fkProperty); a join column without a shadow mapping keeps its name.
      const keysOf = [rel.option?.fkProperty, `${rel.propertyKey}Id`, rel.joinColumn!].filter(
        (key): key is string => !!key,
      );
      const ids = [
        ...new Set(
          rowArray
            .map((row: any) => keysOf.map((key) => row[key]).find((v) => v !== undefined && v !== null))
            .filter((id: unknown) => id !== undefined && id !== null),
        ),
      ];
      if (ids.length > 0) {
        owned.push({ RelatedEntity, pkProperty: relatedPk.propertyKey ?? relatedPk.name, ids });
      }
    }
    return owned;
  }

  /**
   * Soft-deletes or restores the targets of the cascading owning-side
   * OneToOne relations right away — neither statement is held back by the
   * parent's foreign key the way a hard delete is.
   */
  private async removeOwnedTargets<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
    mode: "softDelete" | "restore",
  ): Promise<void> {
    for (const { RelatedEntity, pkProperty, ids } of await this.collectOwnedTargets(entity, criteria, mode)) {
      const targetCriteria = { [pkProperty]: ids.length === 1 ? ids[0] : ids } as any;
      if (mode === "softDelete") {
        await this.ctx.softDelete(RelatedEntity, targetCriteria);
      } else {
        await this.ctx.restore(RelatedEntity, targetCriteria);
      }
    }
  }
}
