import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import {
  ITenantMigrationRunner,
  TenantSyncResult,
} from "../ITenantMigrationRunner";

/**
 * MySqlTenantMigrationRunner
 *
 * MySQL does not support schema-based multi-tenancy.
 * In MySQL, "schema" is a synonym for "database", so schemas cannot be
 * separated within a single database the way PostgreSQL allows.
 *
 * Every method throws UnsupportedError.
 */
export class MySqlTenantMigrationRunner implements ITenantMigrationRunner {
  private unsupported(): never {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      "MySQL does not support schema-based multi-tenancy. " +
        "Use separate databases or a discriminator column approach instead.",
    );
  }

  discoverSchemas(): Promise<string[]> {
    this.unsupported();
  }

  ensureSchema(_tenantId: string): Promise<void> {
    this.unsupported();
  }

  syncTenantSchemas(_tenantIds: string[]): Promise<TenantSyncResult> {
    this.unsupported();
  }

  isProvisioned(_tenantId: string): boolean {
    this.unsupported();
  }

  getProvisionedSchemas(): string[] {
    this.unsupported();
  }

  reset(): void {
    this.unsupported();
  }
}
