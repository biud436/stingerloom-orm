import { Injectable } from "@nestjs/common";
import { DatabaseClient } from "stingerloom-orm";
import { Pool } from "pg";

/**
 * TenantSchemaService
 *
 * Provisions PostgreSQL schemas for each tenant on first request.
 * Uses CREATE SCHEMA IF NOT EXISTS + LIKE ... INCLUDING ALL to clone
 * all public tables into the tenant's schema.
 *
 * Thread-safe: concurrent requests for the same tenant share
 * a single provisioning promise (no duplicate DDL).
 */
@Injectable()
export class TenantSchemaService {
  private readonly provisionedSchemas = new Set<string>();
  private readonly provisioningLocks = new Map<string, Promise<void>>();

  /**
   * Ensures the tenant's schema exists with all required tables.
   * No-op for "public" tenant or already-provisioned schemas.
   */
  async ensureSchema(tenantId: string): Promise<void> {
    if (tenantId === "public" || this.provisionedSchemas.has(tenantId)) {
      return;
    }

    // Dedup concurrent provisioning for the same tenant
    const existing = this.provisioningLocks.get(tenantId);
    if (existing) {
      return existing;
    }

    const promise = this.provision(tenantId).then(() => {
      this.provisionedSchemas.add(tenantId);
      this.provisioningLocks.delete(tenantId);
    });

    this.provisioningLocks.set(tenantId, promise);
    return promise;
  }

  private async provision(tenantId: string): Promise<void> {
    const connector = DatabaseClient.getInstance().getConnection();
    const pool = (connector as any).pool as Pool;

    const client = await pool.connect();
    try {
      const escaped = tenantId.replace(/"/g, '""');

      // 1. Create schema
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${escaped}"`);

      // 2. Get all tables in public schema
      const { rows } = await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      );

      // 3. Clone each table structure into tenant schema
      for (const row of rows) {
        const tableName = row.tablename.replace(/"/g, '""');
        await client.query(
          `CREATE TABLE IF NOT EXISTS "${escaped}"."${tableName}" (LIKE "public"."${tableName}" INCLUDING ALL)`,
        );
      }
    } finally {
      client.release();
    }
  }
}
