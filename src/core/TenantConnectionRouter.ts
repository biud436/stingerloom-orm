/* eslint-disable @typescript-eslint/no-explicit-any */
import { DatabaseClient } from "../DatabaseClient";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { Logger } from "../utils/Logger";
import { ClazzType } from "../utils/types";
import { MetadataContext } from "../metadata/MetadataContext";
import { MetadataLayerRegistry } from "../scanner/MetadataScanner";
import { DatabaseClientOptions } from "./DatabaseClientOptions";
import { EntityManager } from "./EntityManager";

/**
 * Resolver function for `tenantStrategy: "database"`. Returns either an
 * already-registered connection name or a fresh `DatabaseClientOptions`
 * object that the router will use to provision a new pool.
 */
export type TenantDatabaseResolver = (
  tenantId: string,
) =>
  | string
  | DatabaseClientOptions
  | Promise<string | DatabaseClientOptions>;

/**
 * Configuration the `MultiTenantEntityManager` hands to its router. The
 * router does not read the rest of `DatabaseClientOptions` — only these
 * fields are routing-relevant.
 */
export interface TenantConnectionRouterOptions {
  /** Static tenant→connection mapping, checked first. */
  map?: Record<string, string>;
  /** Dynamic resolver, fallback when the map has no entry. */
  resolver?: TenantDatabaseResolver;
  /**
   * Entity classes shared by every tenant pool. Passed to each freshly
   * provisioned EntityManager so all tenant DBs end up with the same
   * schema. The router intentionally ignores `entities` set on
   * resolver-returned options.
   */
  entities: (ClazzType<any> | string)[];
  /** Idle TTL (ms) before an unused tenant pool is closed. 0 disables. */
  idleTtlMs?: number;
  /**
   * Logger for router-level events (cache hits/misses, eviction, etc.).
   * Defaults to a "TenantConnectionRouter" logger.
   */
  logger?: Logger;
}

interface RouterEntry {
  em: EntityManager;
  /** Connection name the router registered with `DatabaseClient`. */
  connectionName: string;
  /** Whether this entry was provisioned by the router (vs. user-supplied). */
  ownedByRouter: boolean;
  /** Last time `resolve()` returned this entry. Used for TTL eviction. */
  lastUsedAt: number;
  /** Optional eviction timer when idleTtlMs > 0. */
  evictTimer?: NodeJS.Timeout;
}

/**
 * Routes a tenant id to a per-tenant `EntityManager` for the
 * `tenantStrategy: "database"` strategy.
 *
 * Internally maintains a `Map<tenantId, EntityManager>` plus an in-flight
 * `Map<tenantId, Promise<EntityManager>>` so that concurrent first-time
 * resolves for the same tenant share a single resolver call. Provisioning
 * one tenant's pool never blocks another's.
 *
 * The router does **not** synchronize tenant DDL on its own — that job
 * belongs to the caller (`MultiTenantEntityManager.register()`), which knows
 * which entities to register and which tenants to eagerly provision.
 */
export class TenantConnectionRouter {
  private readonly entries = new Map<string, RouterEntry>();
  private readonly inFlight = new Map<string, Promise<EntityManager>>();
  private readonly opts: TenantConnectionRouterOptions;
  private readonly logger: Logger;
  /**
   * Monotonically increasing counter used to generate unique connection
   * names for resolver-provisioned pools when the resolver returns options
   * (vs. a name string that already exists in DatabaseClient).
   */
  private static nextSuffix = 0;

  constructor(options: TenantConnectionRouterOptions) {
    this.opts = options;
    this.logger = options.logger ?? new Logger("TenantConnectionRouter");
  }

  /**
   * Resolve `tenantId` to its `EntityManager`, provisioning one on first use
   * if necessary. Concurrent calls for the same tenant share a single
   * resolver invocation. Failures are NOT cached — a subsequent call retries.
   */
  async resolve(tenantId: string): Promise<EntityManager> {
    const cached = this.entries.get(tenantId);
    if (cached) {
      cached.lastUsedAt = Date.now();
      this.scheduleEviction(tenantId, cached);
      return cached.em;
    }

    const inFlight = this.inFlight.get(tenantId);
    if (inFlight) return inFlight;

    const promise = this.provision(tenantId).finally(() => {
      this.inFlight.delete(tenantId);
    });
    this.inFlight.set(tenantId, promise);
    return promise;
  }

  /**
   * Returns every currently-cached EntityManager. Used by
   * `MultiTenantEntityManager.forEachTenant()` for admin fan-out.
   */
  getAll(): { tenantId: string; em: EntityManager }[] {
    return [...this.entries.entries()].map(([tenantId, entry]) => ({
      tenantId,
      em: entry.em,
    }));
  }

  /**
   * Returns the registered tenants without forcing resolution. Tenants known
   * only via `tenantDatabaseResolver` (lazy) are NOT returned until they have
   * been resolved at least once.
   */
  getResolvedTenants(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Closes the pool for a specific tenant and removes it from the router.
   * If the tenant was registered with a name the router did not own (i.e.
   * the user pre-registered it via `DatabaseClient.connect`), the pool is
   * left intact and only the router entry is dropped.
   *
   * Also drops the tenant's metadata layer (if one was created under
   * `tenantId`) so per-scanner caches stop holding entity-class references
   * for the offboarded tenant — see issue #279. Safe no-op if no such layer
   * exists, which is the common case for the "database" strategy where
   * decorator metadata lives on the public layer.
   */
  async release(tenantId: string): Promise<void> {
    const entry = this.entries.get(tenantId);
    if (!entry) return;
    this.entries.delete(tenantId);
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
    if (entry.ownedByRouter) {
      try {
        await entry.em.propagateShutdown({ closeConnections: true });
      } catch (err) {
        this.logger.warn(
          `Error releasing tenant pool '${tenantId}': ${(err as Error).message}`,
        );
      }
    }
    try {
      const registry = MetadataLayerRegistry.getInstance();
      if (registry.getLayer(tenantId)) {
        registry.removeLayer(tenantId);
      } else {
        // No tenant layer ever existed (typical for "database" strategy),
        // but per-scanner caches may still hold references through a
        // resolveAll() snapshot that ran while this tenant was active.
        registry.invalidateScannerCaches();
      }
    } catch (err) {
      this.logger.warn(
        `Error invalidating metadata for tenant '${tenantId}': ${(err as Error).message}`,
      );
    }
  }

  /** Releases every tenant entry the router owns. */
  async releaseAll(): Promise<void> {
    const ids = [...this.entries.keys()];
    await Promise.all(ids.map((id) => this.release(id)));
  }

  /**
   * Pre-provision a tenant before its first query. Used by
   * `MultiTenantEntityManager.register()` for `eagerProvisionTenants`.
   */
  async prewarm(tenantId: string): Promise<EntityManager> {
    return this.resolve(tenantId);
  }

  // ── internal ─────────────────────────────────────────────────────────

  private async provision(tenantId: string): Promise<EntityManager> {
    const resolved = await this.resolveTarget(tenantId);
    const client = DatabaseClient.getInstance();

    let connectionName: string;
    let ownedByRouter: boolean;
    let provisionOptions: DatabaseClientOptions | null;

    if (typeof resolved === "string") {
      // Caller already registered the connection — just look it up.
      if (!client.hasConnection(resolved)) {
        throw new OrmError(
          OrmErrorCode.NOT_CONNECTED,
          `Tenant '${tenantId}' is mapped to connection '${resolved}', but no such connection has been registered with DatabaseClient.`,
          `Call DatabaseClient.getInstance().connect(opts, '${resolved}') before issuing tenant queries.`,
        );
      }
      connectionName = resolved;
      ownedByRouter = false;
      provisionOptions = client.getOptions(resolved);
    } else {
      // Resolver returned full options — provision a fresh pool.
      const safeName = TenantConnectionRouter.sanitizeName(tenantId);
      connectionName = `${safeName}__stg_tenant_${TenantConnectionRouter.nextSuffix++}`;
      ownedByRouter = true;
      provisionOptions = {
        ...resolved,
        // Force entities from the parent register() — schemas must match.
        entities: this.opts.entities,
        // Force the strategy so PostgresConnector skips its search_path
        // override (the tenant id isn't a schema name under "database"),
        // and so the inner EM's strategy class stays in sync.
        tenantStrategy: "database",
      };
    }

    const em = new EntityManager();
    // Provisioning must run under the "public" metadata context, even if the
    // caller's first query happened inside MetadataContext.run("acme"). The
    // global EntityScanner stores @Entity registrations on the public layer
    // (decorators run at module load, no tenant active); reading from any
    // other layer returns an empty entity set, so SchemaRegistrar would
    // create zero tables.
    await MetadataContext.run("public", async () => {
      if (ownedByRouter) {
        // Fresh pool — register() handles connect + synchronize.
        await em.register(provisionOptions!, connectionName);
      } else {
        // Connection already exists in DatabaseClient (the caller registered
        // it). Use attach() so we do NOT call client.connect() again — that
        // would create a brand-new connector and overwrite the existing one
        // in DatabaseClient's map without closing it, leaking the original
        // pool. Schema sync is owned by whoever first registered the
        // connection.
        await em.attach(connectionName, {
          entities: this.opts.entities,
          tenantStrategy: "database",
        });
      }
    });

    const entry: RouterEntry = {
      em,
      connectionName,
      ownedByRouter,
      lastUsedAt: Date.now(),
    };
    this.entries.set(tenantId, entry);
    this.scheduleEviction(tenantId, entry);
    return em;
  }

  private async resolveTarget(
    tenantId: string,
  ): Promise<string | DatabaseClientOptions> {
    const fromMap = this.opts.map?.[tenantId];
    if (fromMap) return fromMap;
    if (!this.opts.resolver) {
      throw new OrmError(
        OrmErrorCode.TENANT_RESOLVER_MISSING,
        `No tenantDatabaseResolver or tenantDatabaseMap entry found for tenant '${tenantId}'.`,
        "Add the tenant to tenantDatabaseMap or provide tenantDatabaseResolver.",
      );
    }
    return this.opts.resolver(tenantId);
  }

  private scheduleEviction(tenantId: string, entry: RouterEntry): void {
    const ttl = this.opts.idleTtlMs ?? 0;
    if (ttl <= 0) return;
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
    entry.evictTimer = setTimeout(() => {
      const idleFor = Date.now() - entry.lastUsedAt;
      if (idleFor >= ttl) {
        void this.release(tenantId);
      }
    }, ttl);
    // Don't keep the event loop alive solely for eviction.
    if (typeof entry.evictTimer.unref === "function") entry.evictTimer.unref();
  }

  private static sanitizeName(tenantId: string): string {
    // Strip anything that is not alphanumeric/underscore so the generated
    // connection name stays simple and printable. The tenant id itself can
    // include arbitrary user input — sanitization protects logs and any
    // downstream tooling that surfaces connection names.
    return tenantId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32) || "tenant";
  }
}
