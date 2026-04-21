/**
 * Options for filtering the tables replicated during tenant provisioning.
 *
 * Filter application order:
 * 1. If `include` is set, only those tables are considered (unset = all tables).
 * 2. If `includePrefix` / `includeSuffix` is set, narrow further.
 * 3. Remove tables listed in `exclude`.
 * 4. Further remove tables matched by `excludePrefix` / `excludeSuffix`.
 */
export interface TenantTableFilterOptions {
  /**
   * List of tables to replicate. Either entity classes or table-name strings.
   * If unset, every table in the source schema is a candidate.
   */
  include?: (string | Function)[];

  /**
   * List of tables to exclude. Either entity classes or table-name strings.
   */
  exclude?: (string | Function)[];

  /** Include only tables that start with one of these prefixes */
  includePrefix?: string[];

  /** Include only tables that end with one of these suffixes */
  includeSuffix?: string[];

  /** Exclude tables that start with one of these prefixes */
  excludePrefix?: string[];

  /** Exclude tables that end with one of these suffixes */
  excludeSuffix?: string[];
}

/**
 * Options for the tenant migration runner.
 */
export interface TenantMigrationRunnerOptions {
  /**
   * Source schema/database whose table structure will be replicated.
   * PostgreSQL default: "public".
   */
  sourceSchema?: string;

  /**
   * Filter options for the tables to replicate.
   * If unset, every table in the source schema is replicated.
   */
  tables?: TenantTableFilterOptions;
}

/**
 * Return result of syncTenantSchemas().
 */
export interface TenantSyncResult {
  /** List of newly created tenants */
  created: string[];
  /** List of tenants that already existed and were skipped */
  skipped: string[];
}

/**
 * ITenantMigrationRunner
 *
 * Common interface for provisioning per-tenant schemas/databases
 * in a multi-tenant environment.
 *
 * - PostgreSQL: schema-based isolation (CREATE SCHEMA + LIKE ... INCLUDING ALL)
 * - MySQL/SQLite: not supported (throws UnsupportedError)
 */
export interface ITenantMigrationRunner {
  /**
   * Returns a list of every tenant (schema/database) that exists in the database.
   */
  discoverSchemas(): Promise<string[]>;

  /**
   * Provisions a single tenant.
   * No-op when the tenant has already been provisioned.
   */
  ensureSchema(tenantId: string): Promise<void>;

  /**
   * Provisions the given list of tenant IDs in bulk.
   * Tenants that already exist are skipped.
   */
  syncTenantSchemas(tenantIds: string[]): Promise<TenantSyncResult>;

  /**
   * Checks whether a specific tenant has been provisioned.
   */
  isProvisioned(tenantId: string): boolean;

  /**
   * Returns the names of every provisioned tenant.
   */
  getProvisionedSchemas(): string[];

  /**
   * Resets the internal provisioning state.
   */
  reset(): void;
}
