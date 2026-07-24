/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql } from "../../utils/sqlTag";
import { ClazzType } from "../../utils";
import { MetadataContext } from "../../metadata/MetadataContext";
import { Conditions } from "../Conditions";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import {
  getTenantColumnMetadata,
  isNonTenantEntity,
} from "../../decorators/TenantColumn";
import {
  TenantQueryStrategy,
  SearchPathStrategy,
  SchemaQualifiedStrategy,
  TenantColumnStrategy,
  DatabaseStrategy,
} from "../TenantQueryStrategy";
import type { DatabaseClientOptions } from "../DatabaseClientOptions";
import type { EntityManagerInternals } from "../EntityManagerInternals";

/** Tenant-column strategy configuration (null when strategy is not "tenant_column"). */
export interface TenantColumnConfig {
  name: string;
  type: "varchar" | "uuid" | "int" | "bigint";
  length?: number;
}

/**
 * Owns the tenant-scoping state and logic extracted from EntityManager:
 * the active `TenantQueryStrategy`, the tenant-column configuration, and
 * the read/write scoping rules (WHERE injection, INSERT auto-fill, raw-query
 * bypass warning).
 *
 * The facade keeps thin delegators plus live accessors for the state tests
 * reassign directly (`em.tenantStrategy`, `em.rawQueryTenantWarned`).
 * Warnings log through `ctx.getLogger()` — the EntityManager's own Logger
 * instance — so `jest.spyOn((em as any).logger, "warn")` keeps observing them.
 *
 * @internal Package-internal — not a public API.
 */
export class TenantScopeManager {
  strategy: TenantQueryStrategy = new SearchPathStrategy();
  columnConfig: TenantColumnConfig | null = null;
  readonly rawQueryWarnedCallSites = new Set<string>();

  constructor(private readonly ctx: EntityManagerInternals) {}

  /** Applies the `tenantStrategy` connection options (connect()/attach() path). */
  configure(options: DatabaseClientOptions): void {
    if (options.tenantStrategy === "schema_qualified") {
      this.strategy = new SchemaQualifiedStrategy();
    } else if (options.tenantStrategy === "tenant_column") {
      this.strategy = new TenantColumnStrategy(
        options.tenantColumnName ?? "tenant_id",
      );
      this.columnConfig = {
        name: options.tenantColumnName ?? "tenant_id",
        type: options.tenantColumnType ?? "varchar",
        length:
          options.tenantColumnType == null ||
          options.tenantColumnType === "varchar"
            ? options.tenantColumnLength ?? 64
            : undefined,
      };
    } else if (options.tenantStrategy === "database") {
      this.strategy = new DatabaseStrategy();
    }
  }

  /** Clears per-instance warning dedup state (propagateShutdown path). */
  reset(): void {
    this.rawQueryWarnedCallSites.clear();
  }

  /**
   * Wrap a table name with optional schema qualification for multi-tenant queries.
   * Uses the configured TenantQueryStrategy to determine whether to prefix with tenant schema.
   */
  wrapTable(tableName: string): string {
    const tenant = this.ctx.isPostgres()
      ? MetadataContext.getCurrentTenant()
      : "public";
    return this.strategy.qualifyTable(tableName, tenant, (n) =>
      this.ctx.wrap(n),
    );
  }

  /**
   * Returns true when the entity is tenant-scoped under the current strategy.
   * False when tenant_column strategy is inactive or the entity is
   * `@NonTenantEntity()`.
   */
  isTenantScopedEntity<T>(entity: ClazzType<T>): boolean {
    return this.columnConfig !== null && !isNonTenantEntity(entity);
  }

  /**
   * Returns a `tenant = ?` predicate for inclusion in WHERE, or null when no
   * filter should be applied. Consolidates the "should I scope this query?"
   * logic in one place so the read/write paths stay symmetrical.
   *
   * Returns null when:
   *   - strategy is not `"tenant_column"`
   *   - entity is `@NonTenantEntity()`
   *   - the current context is unscoped (`MetadataContext.runUnscoped`)
   *   - the current tenant is `"public"` (no tenant context active)
   *
   * The `"public"` case is intentional: reads against the public context are
   * unfiltered so admin/bootstrapping code continues to work. Write paths
   * disallow `"public"` via `applyTenantColumnOnInsert` instead.
   *
   * @param entity         Entity class
   * @param tableAliasOrName  When provided, qualifies the column (for JOINs).
   */
  buildTenantWhereClause<T>(
    entity: ClazzType<T>,
    tableAliasOrName?: string,
  ): Sql | null {
    const config = this.columnConfig;
    if (!config) return null;
    if (isNonTenantEntity(entity)) return null;
    if (MetadataContext.isUnscoped()) return null;
    const tenant = MetadataContext.getCurrentTenant();
    if (tenant === "public") return null;

    const columnName = this.resolveTenantColumnName(entity);
    const col = tableAliasOrName
      ? `${this.ctx.wrap(tableAliasOrName)}.${this.ctx.wrap(columnName)}`
      : this.ctx.wrap(columnName);
    return Conditions.equals(col, tenant);
  }

  /**
   * Resolves the DB column name used by the tenant discriminator for this
   * entity. Honors an explicit `@TenantColumn({ name })` override, else the
   * user's property key (e.g. `tenantId`), else the global config default.
   */
  resolveTenantColumnName<T>(entity: ClazzType<T>): string {
    const userDeclared = getTenantColumnMetadata(entity);
    if (userDeclared) {
      return userDeclared.name ?? userDeclared.propertyKey;
    }
    return this.columnConfig!.name;
  }

  /**
   * Applies tenant-column strategy to an item before INSERT:
   *   - Populates the tenant column from `MetadataContext` when missing.
   *   - Throws `MISSING_TENANT_CONTEXT` when no tenant is active on a
   *     tenant-scoped entity.
   *   - Throws `TENANT_MISMATCH` when the caller supplied a tenant value that
   *     disagrees with the current context (fail-loud; silent-replace would
   *     hide bugs).
   *
   * No-op when the strategy is not `"tenant_column"` or the entity is
   * `@NonTenantEntity()`.
   */
  applyTenantColumnOnInsert<T>(entity: ClazzType<T>, item: Partial<T>): void {
    const config = this.columnConfig;
    if (!config) return;
    if (isNonTenantEntity(entity)) return;

    const tenant = MetadataContext.getCurrentTenant();
    if (tenant === "public") {
      throw new OrmError(
        OrmErrorCode.MISSING_TENANT_CONTEXT,
        `Cannot INSERT into tenant-scoped entity '${entity.name}' without an active tenant context. ` +
          `Wrap the call in MetadataContext.run("<tenant>", ...), or mark the entity with @NonTenantEntity() ` +
          `if it is intentionally global.`,
      );
    }

    // Determine where to write the tenant value:
    //   - If the user declared @TenantColumn, use the property key they chose.
    //   - Otherwise the column was implicitly injected; fall back to the column name.
    const userDeclared = getTenantColumnMetadata(entity);
    const propKey = userDeclared?.propertyKey ?? config.name;
    const colName = userDeclared?.name ?? config.name;

    const supplied =
      (item as any)[propKey] !== undefined
        ? (item as any)[propKey]
        : (item as any)[colName];

    if (supplied !== undefined && supplied !== null && supplied !== tenant) {
      throw new OrmError(
        OrmErrorCode.TENANT_MISMATCH,
        `Tenant mismatch on INSERT into '${entity.name}': supplied tenant='${supplied}' ` +
          `but MetadataContext tenant='${tenant}'. The supplied value is rejected to catch bugs early. ` +
          `Omit the tenant field so the ORM can auto-fill it, or run inside the matching context.`,
      );
    }

    (item as any)[propKey] = tenant;
    if (propKey !== colName) {
      (item as any)[colName] = tenant;
    }
  }

  /**
   * Emit a one-time-per-call-site warning when `em.query()` is invoked under
   * an active tenant context while the `"tenant_column"` strategy is in use.
   *
   * Raw SQL bypasses the automatic `WHERE tenant_id = ?` injection that the
   * strategy applies to `find()` / query builders / relation loaders, so a
   * hand-written query can silently return or mutate rows belonging to other
   * tenants. The warning is suppressed when:
   *
   * - the strategy is not `tenant_column` (other strategies scope at the
   *   connection/schema level, so raw SQL is still safe)
   * - no tenant context is active (bootstrap/admin path)
   * - the current context is in `runUnscoped()` mode (user opted in)
   * - the caller is an internal ORM frame (SelectQueryBuilder, RelationLoader,
   *   RawPipeline, etc. — those builders already inject the predicate before
   *   reaching `em.query()`)
   */
  warnIfRawQueryBypassesTenant(): void {
    if (this.columnConfig === null) return;
    if (!MetadataContext.isActive()) return;
    if (MetadataContext.isUnscoped()) return;
    const tenant = MetadataContext.getCurrentTenant();
    if (tenant === "public") return;

    const stack = new Error().stack;
    if (!stack) return;

    const lines = stack.split("\n");
    let callerFrame: string | undefined;
    for (let i = 1; i < lines.length; i++) {
      const frame = lines[i];
      // Skip frames from the EM facade / extracted engine files and node internals
      if (frame.includes("EntityManager.ts")) continue;
      if (frame.includes("EntityManager.js")) continue;
      if (frame.includes("TenantScopeManager.ts")) continue;
      if (frame.includes("TenantScopeManager.js")) continue;
      if (frame.includes("RawQueryRunner.ts")) continue;
      if (frame.includes("RawQueryRunner.js")) continue;
      if (frame.includes("node:internal")) continue;
      // Skip frames from internal ORM code — those callers either run under
      // a tenant-aware builder or are part of the scoping machinery itself.
      if (/stingerloom-orm[/\\](src|dist)[/\\]/.test(frame)) continue;
      if (/node_modules[/\\]@stingerloom[/\\]orm[/\\]/.test(frame)) continue;
      callerFrame = frame.trim();
      break;
    }
    if (!callerFrame) return;

    if (this.rawQueryWarnedCallSites.has(callerFrame)) return;
    this.rawQueryWarnedCallSites.add(callerFrame);

    this.ctx.getLogger().warn(
      `[multi-tenancy] em.query() called under tenant="${tenant}" — raw SQL ` +
        `bypasses automatic WHERE ${this.columnConfig.name} injection. ` +
        `Filter by the tenant column manually, or wrap the call in ` +
        `MetadataContext.runUnscoped() when cross-tenant access is intended. ` +
        `Call site: ${callerFrame}`,
    );
  }

  /**
   * Checks if a tenant context (MetadataContext.run) is active.
   * Logs a warning if not — useful in middleware/guards to catch missing context early.
   * @returns true if tenant context is active, false if falling back to "public"
   */
  assertTenantContext(): boolean {
    if (MetadataContext.isActive()) {
      return true;
    }
    this.ctx.getLogger().warn(
      `[multi-tenancy] No tenant context active — query will use "public" schema. ` +
        `Wrap your code in MetadataContext.run(tenantId, callback).`,
    );
    return false;
  }
}
