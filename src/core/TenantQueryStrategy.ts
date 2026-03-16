/**
 * Strategy pattern for multi-tenant query table qualification.
 *
 * - SearchPathStrategy (default): Uses SET LOCAL search_path inside a transaction.
 *   Safe for all cases but requires 5 round-trips for tenant reads.
 * - SchemaQualifiedStrategy: Uses schema-qualified table names (e.g. "tenant_a"."users").
 *   Allows single-round-trip tenant reads without transactions.
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
}

/**
 * Default strategy: relies on SET LOCAL search_path inside a transaction.
 * Table names are wrapped without schema qualification.
 */
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

/**
 * Schema-qualified strategy: prefixes table names with the tenant schema.
 * Eliminates the need for transactions on tenant reads (1 round-trip).
 */
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
