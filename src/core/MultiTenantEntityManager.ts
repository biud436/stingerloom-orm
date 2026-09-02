/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from "async_hooks";
import { ClazzType } from "../utils/types";
import { Logger } from "../utils/Logger";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { MetadataContext } from "../metadata/MetadataContext";
import { DatabaseClientOptions } from "./DatabaseClientOptions";
import { EntityManager, TransactionOptions } from "./EntityManager";
import { BaseRepository } from "./BaseRepository";
import { TenantConnectionRouter } from "./TenantConnectionRouter";
import { FindOption, UpdateData, WhereClause } from "../dialects/FindOption";
import { CursorPaginationOption, CursorPaginationResult } from "./CursorPagination";
import { PagePaginationOption, PagePaginationResult } from "./PagePagination";
import { DeleteResult } from "../types/DeleteResult";
import { ExplainResult } from "./ExplainResult";
import { StingerloomPlugin } from "./plugin/StingerloomPlugin";
import { EntityEventListener, EntityEventType } from "./EntityEventEmitter";
import { EntitySubscriber } from "./EntitySubscriber";
import { SelectQueryBuilder, EntityRef } from "./SelectQueryBuilder";
import { BaseRawQueryBuilder } from "./BaseRawQueryBuilder";
import { InsertQueryBuilder } from "./InsertQueryBuilder";

/**
 * The subset of `DatabaseClientOptions` that controls multi-tenant routing.
 * Pulled out into its own type so `MultiTenantEntityManager.register()` can
 * accept either a tenant-aware option bundle or — for advanced cases — the
 * raw router options directly.
 */
type DatabaseStrategyOptions = Pick<
  DatabaseClientOptions,
  | "tenantStrategy"
  | "tenantDatabaseResolver"
  | "tenantDatabaseMap"
  | "eagerProvisionTenants"
  | "publicTenantBehavior"
  | "tenantConnectionTtlMs"
>;

/**
 * Front door for the `tenantStrategy: "database"` strategy.
 *
 * Holds a "default" EntityManager (the admin / public DB the caller passed
 * to `register()`) plus a `TenantConnectionRouter` that lazy-provisions one
 * EntityManager per tenant. Every CRUD / query / transaction method picks
 * the right EntityManager from `MetadataContext.getCurrentTenant()` and
 * delegates.
 *
 * Use this together with `tenantDatabaseResolver` (lazy) or
 * `tenantDatabaseMap` (eager). See `docs/multi-tenancy.md` Strategy 4.
 *
 * @example
 * ```ts
 * const em = new MultiTenantEntityManager();
 * await em.register({
 *   type: "postgres",
 *   database: "app_admin",
 *   entities: [User, Post],
 *   tenantStrategy: "database",
 *   tenantDatabaseResolver: async (tenantId) => ({
 *     type: "postgres",
 *     database: `app_${tenantId}`,
 *     // ... per-tenant connection options
 *   }),
 * });
 *
 * await MetadataContext.run("acme", () => em.find(User));   // → app_acme DB
 * await MetadataContext.run("globex", () => em.find(User)); // → app_globex DB
 * ```
 */
export class MultiTenantEntityManager {
  private readonly logger = new Logger("MultiTenantEntityManager");
  private readonly defaultEm: EntityManager = new EntityManager();
  private router: TenantConnectionRouter | null = null;
  private publicBehavior: "default" | "throw" = "default";
  private installedPlugins: StingerloomPlugin<any>[] = [];
  /**
   * The DatabaseClient connection name under which the admin/public EM was
   * registered. Captured so multiple MTEM instances (e.g. NestJS named
   * connections) can each own their own admin pool without colliding on
   * a hard-coded "default" name. See `register()`.
   */
  private adminConnectionName = "default";
  /**
   * Listeners and subscribers registered via `on()` / `addSubscriber()` are
   * broadcast to every per-tenant EntityManager — both currently resolved
   * tenants and any future tenants resolved on-demand. Stored here so
   * lazy-provisioned EMs can replay them.
   */
  private readonly broadcastListeners: Array<{
    event: EntityEventType;
    listener: EntityEventListener;
  }> = [];
  private readonly broadcastSubscribers: EntitySubscriber<any>[] = [];

  /**
   * Captured tenant id for the current transaction (set by `transaction()`).
   * Used by `pickEm()` to detect cross-tenant transaction attempts.
   */
  private static readonly txTenantStorage = new AsyncLocalStorage<{
    tenantId: string;
  }>();

  /**
   * Initialize the manager. The `options` describe the **default DB**
   * (admin / public catalog) plus tenant routing config.
   *
   * @param connectionName  DatabaseClient name for the admin/public pool.
   *   Defaults to `"default"` so single-MTEM setups stay backward compatible.
   *   Multi-MTEM (e.g. NestJS named connections) MUST pass a unique name
   *   per instance to avoid stomping each other's admin connector — this
   *   maps to a per-instance `${connectionName}__admin` for non-default
   *   names so the admin pool does not collide with any plain
   *   `EntityManager` registered under the same logical name.
   */
  async register(
    options: DatabaseClientOptions,
    connectionName = "default",
  ): Promise<void> {
    if (options.tenantStrategy !== "database") {
      throw new OrmError(
        OrmErrorCode.INVALID_CONFIG,
        `MultiTenantEntityManager requires tenantStrategy: "database", got "${options.tenantStrategy ?? "<unset>"}".`,
        "Pass tenantStrategy: \"database\" in DatabaseClientOptions, or use a plain EntityManager for other strategies.",
      );
    }
    if (!options.tenantDatabaseResolver && !options.tenantDatabaseMap) {
      throw new OrmError(
        OrmErrorCode.TENANT_RESOLVER_MISSING,
        "tenantStrategy: \"database\" requires either tenantDatabaseResolver or tenantDatabaseMap.",
        "Add tenantDatabaseResolver: (tenantId) => DatabaseClientOptions, or list known tenants in tenantDatabaseMap.",
      );
    }

    this.publicBehavior = options.publicTenantBehavior ?? "default";

    // Pick an admin connection name that does not collide with router-
    // provisioned tenant pools or with plain @InjectEntityManager()-style
    // connections registered under the same logical name. We special-case
    // "default" so single-MTEM apps keep the historical name.
    this.adminConnectionName =
      connectionName === "default" ? "default" : `${connectionName}__admin`;
    await this.defaultEm.register(options, this.adminConnectionName);

    this.router = new TenantConnectionRouter({
      map: options.tenantDatabaseMap,
      resolver: options.tenantDatabaseResolver,
      entities: options.entities,
      idleTtlMs: options.tenantConnectionTtlMs,
    });

    // Eagerly provision listed tenants so the first request never pays the
    // cold-start cost.
    if (options.eagerProvisionTenants?.length) {
      await Promise.all(
        options.eagerProvisionTenants.map((id) => this.router!.prewarm(id)),
      );
      // Replay broadcast listeners onto eager EMs (none today, but future-proof).
      for (const { tenantId } of this.router!.getAll()) {
        this.applyBroadcastsTo(tenantId);
      }
    }
  }

  /**
   * Resolve the EntityManager that should service the current async context.
   * Throws if `publicTenantBehavior: "throw"` and no tenant is set.
   */
  async pickEm(): Promise<EntityManager> {
    const tx = MultiTenantEntityManager.txTenantStorage.getStore();
    const currentTenant = MetadataContext.getCurrentTenant();
    if (tx && tx.tenantId !== currentTenant) {
      throw new OrmError(
        OrmErrorCode.CROSS_TENANT_TRANSACTION,
        `Cross-tenant transaction detected: outer transaction is bound to tenant "${tx.tenantId}", but inner code switched to tenant "${currentTenant}".`,
        "A single transaction can only target one physical database under tenantStrategy: \"database\". Either nest MetadataContext.run() outside the transaction, or split the work into separate per-tenant transactions.",
      );
    }
    if (currentTenant === "public") {
      if (this.publicBehavior === "throw") {
        throw new OrmError(
          OrmErrorCode.MISSING_TENANT_CONTEXT,
          "Query issued without an active MetadataContext under tenantStrategy: \"database\" with publicTenantBehavior: \"throw\".",
          "Wrap the call in MetadataContext.run(tenantId, () => ...).",
        );
      }
      return this.defaultEm;
    }
    if (!this.router) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "MultiTenantEntityManager.register() has not been called.",
      );
    }
    const em = await this.router.resolve(currentTenant);
    // Apply outstanding broadcasts to the freshly-provisioned EM so events /
    // subscribers attached before the tenant was known still fire.
    this.applyBroadcastsTo(currentTenant, em);
    return em;
  }

  /**
   * Run `fn` against every currently resolved tenant EntityManager (plus, if
   * `includeDefault`, the admin EM). Useful for cross-tenant aggregates,
   * health checks, and migrations.
   *
   * Order is **not guaranteed**. Failures of individual tenants surface as
   * rejected entries in the returned array (no all-or-nothing semantics) when
   * `mode: "settled"`; default `"all"` rejects fast on the first error.
   */
  async forEachTenant<T>(
    fn: (em: EntityManager, tenantId: string) => Promise<T>,
    options?: {
      mode?: "all" | "settled" | "sequential";
      includeDefault?: boolean;
    },
  ): Promise<Array<{ tenantId: string; value?: T; error?: unknown }>> {
    const mode = options?.mode ?? "all";
    if (!this.router) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "MultiTenantEntityManager.register() has not been called.",
      );
    }
    const targets = this.router.getAll();
    if (options?.includeDefault) {
      targets.unshift({ tenantId: "__default__", em: this.defaultEm });
    }

    if (mode === "sequential") {
      const out: Array<{ tenantId: string; value?: T; error?: unknown }> = [];
      for (const { tenantId, em } of targets) {
        try {
          out.push({ tenantId, value: await fn(em, tenantId) });
        } catch (error) {
          out.push({ tenantId, error });
          if (mode === "sequential") throw error;
        }
      }
      return out;
    }

    if (mode === "settled") {
      const settled = await Promise.allSettled(
        targets.map(({ tenantId, em }) =>
          fn(em, tenantId).then((value) => ({ tenantId, value })),
        ),
      );
      return settled.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : { tenantId: targets[i].tenantId, error: r.reason },
      );
    }

    // mode === "all"
    const values = await Promise.all(
      targets.map(({ tenantId, em }) =>
        fn(em, tenantId).then((value) => ({ tenantId, value })),
      ),
    );
    return values;
  }

  /**
   * The admin/public EntityManager passed to `register()`. Use for global
   * tables that live outside any tenant's DB.
   */
  getDefaultEntityManager(): EntityManager {
    return this.defaultEm;
  }

  /** Direct access to the router (for advanced fan-out / inspection). */
  getRouter(): TenantConnectionRouter {
    if (!this.router) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "MultiTenantEntityManager.register() has not been called.",
      );
    }
    return this.router;
  }

  // ── CRUD delegation ────────────────────────────────────────────────

  async find<T>(entity: ClazzType<T>, options?: FindOption<T>): Promise<T[]> {
    return (await this.pickEm()).find(entity, options);
  }

  async findOne<T>(entity: ClazzType<T>, options: FindOption<T>): Promise<T | null> {
    return (await this.pickEm()).findOne(entity, options);
  }

  async findOneOrFail<T>(entity: ClazzType<T>, options: FindOption<T>): Promise<T> {
    return (await this.pickEm()).findOneOrFail(entity, options);
  }

  async findByPK<T>(entity: ClazzType<T>, pk: any): Promise<T | null> {
    return (await this.pickEm()).findByPK(entity, pk);
  }

  async findByPKs<T>(entity: ClazzType<T>, pks: any[]): Promise<T[]> {
    return (await this.pickEm()).findByPKs(entity, pks);
  }

  async findAndCount<T>(
    entity: ClazzType<T>,
    options?: FindOption<T>,
  ): Promise<[T[], number]> {
    return (await this.pickEm()).findAndCount(entity, options);
  }

  async findWithPage<T>(
    entity: ClazzType<T>,
    options: PagePaginationOption<T>,
  ): Promise<PagePaginationResult<T>> {
    return (await this.pickEm()).findWithPage(entity, options);
  }

  async findWithCursor<T>(
    entity: ClazzType<T>,
    options: CursorPaginationOption<T>,
  ): Promise<CursorPaginationResult<T>> {
    return (await this.pickEm()).findWithCursor(entity, options);
  }

  async *stream<T>(
    entity: ClazzType<T>,
    options?: FindOption<T>,
    batchSize?: number,
  ): AsyncGenerator<T> {
    const em = await this.pickEm();
    yield* em.stream(entity, options, batchSize);
  }

  async *streamBatch<T>(
    entity: ClazzType<T>,
    options?: FindOption<T>,
    batchSize?: number,
  ): AsyncGenerator<T[]> {
    // Mirrors EntityManager's (entity, options, batchSize) signature — the
    // old `options & { batchSize }` shape was never consumed by the delegate,
    // so the requested batch size silently fell back to the default.
    const em = await this.pickEm();
    yield* em.streamBatch(entity, options, batchSize);
  }

  async save<T>(entity: ClazzType<T>, item: Partial<T>): Promise<T> {
    return (await this.pickEm()).save(entity, item as any);
  }

  async saveMany<T>(entity: ClazzType<T>, items: Partial<T>[]): Promise<T[]> {
    return (await this.pickEm()).saveMany(entity, items as any);
  }

  async insertMany<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
  ): Promise<{ affected: number }> {
    return (await this.pickEm()).insertMany(entity, items as any);
  }

  async upsert<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    return (await this.pickEm()).upsert(entity, data as any, conflictColumns);
  }

  async batchUpsert<T>(
    entity: ClazzType<T>,
    items: Partial<T>[],
    conflictColumns?: string[],
  ): Promise<{ affected: number }> {
    return (await this.pickEm()).batchUpsert(entity, items as any, conflictColumns);
  }

  /**
   * Resolves the tenant's EntityManager and returns an `InsertQueryBuilder`
   * bound to it. Async, unlike `EntityManager.createInsertBuilder`, because
   * the tenant connection may still need to be opened.
   */
  async createInsertBuilder<T>(
    entity: ClazzType<T>,
    alias?: string,
  ): Promise<InsertQueryBuilder<T>> {
    return (await this.pickEm()).createInsertBuilder(entity, alias);
  }

  async delete<T>(entity: ClazzType<T>, conditions: WhereClause<T>): Promise<DeleteResult> {
    return (await this.pickEm()).delete(entity, conditions);
  }

  async deleteMany<T>(entity: ClazzType<T>, ids: unknown[]): Promise<DeleteResult> {
    return (await this.pickEm()).deleteMany(entity, ids);
  }

  async updateMany<T>(
    entity: ClazzType<T>,
    data: UpdateData<T>,
    options: { where: WhereClause<T> },
  ): Promise<{ affected: number }> {
    return (await this.pickEm()).updateMany(entity, data, options);
  }

  async softDelete<T>(entity: ClazzType<T>, conditions: WhereClause<T>): Promise<DeleteResult> {
    return (await this.pickEm()).softDelete(entity, conditions);
  }

  async restore<T>(entity: ClazzType<T>, conditions: WhereClause<T>): Promise<DeleteResult> {
    return (await this.pickEm()).restore(entity, conditions);
  }

  async clear<T>(entity: ClazzType<T>): Promise<void> {
    return (await this.pickEm()).clear(entity);
  }

  // ── Aggregates ─────────────────────────────────────────────────────

  async count<T>(entity: ClazzType<T>, where?: WhereClause<T>): Promise<number> {
    return (await this.pickEm()).count(entity, where);
  }

  async exists<T>(entity: ClazzType<T>, where?: WhereClause<T>): Promise<boolean> {
    return (await this.pickEm()).exists(entity, where);
  }

  async sum<T>(entity: ClazzType<T>, field: keyof T & string, where?: WhereClause<T>): Promise<number> {
    return (await this.pickEm()).sum(entity, field, where);
  }

  async avg<T>(entity: ClazzType<T>, field: keyof T & string, where?: WhereClause<T>): Promise<number> {
    return (await this.pickEm()).avg(entity, field, where);
  }

  async min<T>(entity: ClazzType<T>, field: keyof T & string, where?: WhereClause<T>): Promise<number> {
    return (await this.pickEm()).min(entity, field, where);
  }

  async max<T>(entity: ClazzType<T>, field: keyof T & string, where?: WhereClause<T>): Promise<number> {
    return (await this.pickEm()).max(entity, field, where);
  }

  async explain<T>(entity: ClazzType<T>, findOption: FindOption<T> = {}): Promise<ExplainResult> {
    return (await this.pickEm()).explain(entity, findOption);
  }

  // ── Builders ────────────────────────────────────────────────────────

  async createQueryBuilder(): Promise<BaseRawQueryBuilder>;
  async createQueryBuilder<T>(
    entity: ClazzType<T>,
    alias: string,
  ): Promise<SelectQueryBuilder<T, T>>;
  async createQueryBuilder<T>(ref: EntityRef<T>): Promise<SelectQueryBuilder<T, T>>;
  async createQueryBuilder<T>(
    entityOrRef?: ClazzType<T> | EntityRef<T>,
    alias?: string,
  ): Promise<BaseRawQueryBuilder | SelectQueryBuilder<T, T>> {
    const em = await this.pickEm();
    if (entityOrRef === undefined) return em.createQueryBuilder();
    return em.createQueryBuilder(entityOrRef as any, alias as any);
  }

  // ── Transactions ────────────────────────────────────────────────────

  async transaction<R>(
    callback: (em: EntityManager) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R> {
    const em = await this.pickEm();
    const capturedTenant = MetadataContext.getCurrentTenant();
    return MultiTenantEntityManager.txTenantStorage.run(
      { tenantId: capturedTenant },
      () => em.transaction(callback as any, options) as Promise<R>,
    );
  }

  /**
   * Convenience helper: run `callback` under `MetadataContext.run(tenantId)`.
   * Equivalent to `MetadataContext.run(tenantId, () => callback(em))`.
   */
  async withTenant<R>(
    tenantId: string,
    callback: (em: MultiTenantEntityManager) => Promise<R>,
  ): Promise<R> {
    return MetadataContext.run(tenantId, () => callback(this)) as Promise<R>;
  }

  // ── Raw query / repositories ────────────────────────────────────────

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    return (await this.pickEm()).query(sql, params);
  }

  /**
   * Returns a thin proxy that forwards every BaseRepository method through
   * `pickEm()`. Necessary because the underlying `BaseRepository` is bound
   * to a specific EntityManager, and the right one depends on the current
   * tenant context at call time.
   */
  getRepository<T extends object>(entity: ClazzType<T>): BaseRepository<T> {
    const self = this;
    // Use a Proxy because BaseRepository's surface is wide (~30 methods) and
    // mostly mirrors EntityManager. The proxy resolves the per-tenant
    // BaseRepository on every property access, so every call hits the
    // correct DB.
    const proxy = new Proxy(
      // Use the default EM's repository as the prototype for typeof / instanceof
      // checks; intercept all method calls so the actual work happens on the
      // tenant-resolved repository instead.
      self.defaultEm.getRepository(entity) as any,
      {
        get(target, prop, receiver) {
          // Special-case: synchronous property reads that don't need a DB
          // (e.g. "constructor"). Delegate to the default repo.
          if (typeof (target as any)[prop] !== "function") {
            return Reflect.get(target, prop, receiver);
          }
          return (...args: any[]) =>
            self.pickEm().then((em) => {
              const repo = em.getRepository(entity) as any;
              return repo[prop](...args);
            });
        },
      },
    );
    return proxy as BaseRepository<T>;
  }

  // ── Plugins / events / subscribers ──────────────────────────────────

  /**
   * Install a plugin on the default EM and replay it on every currently
   * resolved tenant EM. Lazily-provisioned tenants will receive the plugin
   * the first time they are resolved.
   */
  extend(plugin: StingerloomPlugin<any>): void {
    this.installedPlugins.push(plugin);
    this.defaultEm.extend(plugin);
    if (this.router) {
      for (const { em } of this.router.getAll()) {
        em.extend(plugin);
      }
    }
  }

  on(event: EntityEventType, listener: EntityEventListener): void {
    this.broadcastListeners.push({ event, listener });
    this.defaultEm.on(event, listener);
    if (this.router) {
      for (const { em } of this.router.getAll()) {
        em.on(event, listener);
      }
    }
  }

  off(event: EntityEventType, listener: EntityEventListener): void {
    const idx = this.broadcastListeners.findIndex(
      (b) => b.event === event && b.listener === listener,
    );
    if (idx !== -1) this.broadcastListeners.splice(idx, 1);
    this.defaultEm.off(event, listener);
    if (this.router) {
      for (const { em } of this.router.getAll()) {
        em.off(event, listener);
      }
    }
  }

  addSubscriber(subscriber: EntitySubscriber<any>): void {
    this.broadcastSubscribers.push(subscriber);
    this.defaultEm.addSubscriber(subscriber);
    if (this.router) {
      for (const { em } of this.router.getAll()) {
        em.addSubscriber(subscriber);
      }
    }
  }

  removeSubscriber(subscriber: EntitySubscriber<any>): void {
    const idx = this.broadcastSubscribers.indexOf(subscriber);
    if (idx !== -1) this.broadcastSubscribers.splice(idx, 1);
    this.defaultEm.removeSubscriber(subscriber);
    if (this.router) {
      for (const { em } of this.router.getAll()) {
        em.removeSubscriber(subscriber);
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Closes every tenant pool plus the default pool, in LIFO order across the
   * router and after the router has finished with `propagateShutdown`.
   */
  async propagateShutdown(options?: {
    gracefulTimeoutMs?: number;
    closeConnections?: boolean;
  }): Promise<boolean> {
    let allCompleted = true;
    if (this.router) {
      // Each router-owned EM is independently shutdown; entries the user
      // pre-registered via DatabaseClient.connect retain their pools.
      const tenants = this.router.getAll();
      const results = await Promise.all(
        tenants.map(async ({ em }) => {
          try {
            return await em.propagateShutdown(options);
          } catch (err) {
            this.logger.warn(
              `Tenant shutdown error: ${(err as Error).message}`,
            );
            return false;
          }
        }),
      );
      allCompleted = results.every(Boolean) && allCompleted;
      await this.router.releaseAll();
    }
    const defaultOk = await this.defaultEm.propagateShutdown(options);
    return defaultOk && allCompleted;
  }

  // ── internal ────────────────────────────────────────────────────────

  /**
   * Apply pending plugins, listeners, and subscribers to a tenant EM. Called
   * on the first `resolve()` for that tenant so events registered before the
   * tenant existed still fire on it.
   */
  private appliedTo = new Set<string>();
  private applyBroadcastsTo(tenantId: string, em?: EntityManager): void {
    if (this.appliedTo.has(tenantId)) return;
    if (!em) {
      const found = this.router?.getAll().find((e) => e.tenantId === tenantId);
      if (!found) return;
      em = found.em;
    }
    this.appliedTo.add(tenantId);
    for (const plugin of this.installedPlugins) em.extend(plugin);
    for (const { event, listener } of this.broadcastListeners) em.on(event, listener);
    for (const sub of this.broadcastSubscribers) em.addSubscriber(sub);
  }

  /** @internal — re-export of the option type for the NestJS module to consume. */
  static readonly _STRATEGY_OPTION_KEYS: ReadonlyArray<keyof DatabaseStrategyOptions> = [
    "tenantStrategy",
    "tenantDatabaseResolver",
    "tenantDatabaseMap",
    "eagerProvisionTenants",
    "publicTenantBehavior",
    "tenantConnectionTtlMs",
  ];
}
