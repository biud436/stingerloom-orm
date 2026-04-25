import { MetadataContext } from "../metadata/MetadataContext";

/**
 * Strategy pattern for multi-tenant query handling.
 *
 * Four built-in strategies:
 *
 * - **SearchPathStrategy** (default): PostgreSQL `SET LOCAL search_path` inside a
 *   transaction. Safe for all cases but requires ~5 round-trips per tenant read.
 * - **SchemaQualifiedStrategy**: Schema-qualified table names (e.g.
 *   `"tenant_a"."users"`). Single-round-trip reads without transactions.
 *   PostgreSQL-only.
 * - **TenantColumnStrategy**: Discriminator column on every tenant-scoped entity.
 *   Works on all dialects. Requires composite indexes and `@NonTenantEntity()`
 *   opt-outs for global tables.
 * - **DatabaseStrategy**: Physical database-per-tenant. The router layer
 *   selects a different connection pool per tenant; this strategy class is a
 *   no-op marker — it does not modify queries because isolation is enforced
 *   at the connection level, not in SQL.
 */
export interface TenantQueryStrategy {
  /** Whether tenant reads require a transaction (for SET LOCAL search_path). */
  needsTransactionForTenantRead(): boolean;

  /**
   * Qualify a table name for the given tenant context.
   * @param tableName Raw table name
   * @param tenant Current tenant identifier ("public" for default)
   * @param wrap Driver-specific identifier wrapping function
   */
  qualifyTable(
    tableName: string,
    tenant: string,
    wrap: (s: string) => string,
  ): string;

  /**
   * Build a `WHERE tenant = ?` predicate for tenant-scoped queries.
   * Returns `null` when no predicate should be injected — either because the
   * strategy uses a different isolation mechanism (search_path,
   * schema_qualified) or because the current context is "public" or unscoped.
   *
   * @param tableAlias Optional alias to qualify the column (for JOINed queries)
   * @param wrap Driver-specific identifier wrapping function
   */
  buildTenantPredicate?(
    tableAlias: string | null,
    wrap: (s: string) => string,
  ): { sql: string; param: string } | null;

  /**
   * Returns the column name the strategy uses, if any.
   * Only `TenantColumnStrategy` implements this; other strategies return null.
   */
  getTenantColumnName?(): string | null;
}

export class SearchPathStrategy implements TenantQueryStrategy {
  needsTransactionForTenantRead(): boolean {
    return true;
  }

  qualifyTable(
    tableName: string,
    _tenant: string,
    wrap: (s: string) => string,
  ): string {
    return wrap(tableName);
  }
}

export class SchemaQualifiedStrategy implements TenantQueryStrategy {
  needsTransactionForTenantRead(): boolean {
    return false;
  }

  qualifyTable(
    tableName: string,
    tenant: string,
    wrap: (s: string) => string,
  ): string {
    return tenant !== "public"
      ? `${wrap(tenant)}.${wrap(tableName)}`
      : wrap(tableName);
  }
}

/**
 * Discriminator-column strategy.
 *
 * Adds a tenant column (default `tenant_id`) to every tenant-scoped entity's
 * DDL, auto-fills it on INSERT, and injects `WHERE tenant_id = ?` on SELECT /
 * UPDATE / DELETE. Tenant isolation is enforced in application-generated SQL
 * rather than by the database, so raw SQL bypasses the filter — callers of
 * `em.query()` must apply the predicate themselves.
 *
 * Works uniformly across MySQL, PostgreSQL, and SQLite.
 */
export class TenantColumnStrategy implements TenantQueryStrategy {
  constructor(
    private readonly columnName: string = "tenant_id",
  ) {}

  needsTransactionForTenantRead(): boolean {
    return false;
  }

  qualifyTable(
    tableName: string,
    _tenant: string,
    wrap: (s: string) => string,
  ): string {
    return wrap(tableName);
  }

  buildTenantPredicate(
    tableAlias: string | null,
    wrap: (s: string) => string,
  ): { sql: string; param: string } | null {
    if (MetadataContext.isUnscoped()) {
      return null;
    }
    const tenant = MetadataContext.getCurrentTenant();
    if (tenant === "public") {
      return null;
    }
    const qualified = tableAlias
      ? `${wrap(tableAlias)}.${wrap(this.columnName)}`
      : wrap(this.columnName);
    return { sql: `${qualified} = ?`, param: tenant };
  }

  getTenantColumnName(): string {
    return this.columnName;
  }
}

/**
 * Database-per-tenant strategy.
 *
 * Each tenant maps to its own physical database connection (pool). The
 * `MultiTenantEntityManager` proxy resolves the current tenant from
 * `MetadataContext` and dispatches queries to the matching `EntityManager`,
 * each of which is bound to its own pool via the existing named-connection
 * mechanism in `DatabaseClient`.
 *
 * Because isolation is enforced at the connection level, no SQL-level
 * predicates are injected and table names are not qualified.
 */
export class DatabaseStrategy implements TenantQueryStrategy {
  needsTransactionForTenantRead(): boolean {
    return false;
  }

  qualifyTable(
    tableName: string,
    _tenant: string,
    wrap: (s: string) => string,
  ): string {
    return wrap(tableName);
  }

  buildTenantPredicate(): null {
    return null;
  }
}
