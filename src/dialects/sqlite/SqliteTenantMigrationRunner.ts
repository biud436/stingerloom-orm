import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import {
  ITenantMigrationRunner,
  TenantSyncResult,
} from "../ITenantMigrationRunner";

/**
 * SqliteTenantMigrationRunner
 *
 * SQLite does not support schema-based multi-tenancy.
 * SQLite is a single-file database, so schema separation is not possible.
 *
 * Every method throws UnsupportedError.
 */
export class SqliteTenantMigrationRunner implements ITenantMigrationRunner {
  private unsupported(): never {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      "SQLite does not support schema-based multi-tenancy. " +
        "Use separate database files or a discriminator column approach instead.",
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
