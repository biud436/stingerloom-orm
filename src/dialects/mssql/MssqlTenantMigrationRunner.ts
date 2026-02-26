import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import {
  ITenantMigrationRunner,
  TenantSyncResult,
} from "../ITenantMigrationRunner";

/**
 * MssqlTenantMigrationRunner
 *
 * MSSQL은 스키마를 지원하지만, 현재 이 ORM에서 스키마 기반
 * 멀티테넌시 구현은 PostgreSQL만 지원합니다.
 *
 * 향후 MSSQL 스키마 기반 멀티테넌시가 필요하면 이 클래스를 구현하세요.
 * 모든 메서드는 UnsupportedError를 throw합니다.
 */
export class MssqlTenantMigrationRunner implements ITenantMigrationRunner {
  private unsupported(): never {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      "MSSQL schema-based multi-tenancy is not yet implemented. " +
        "Contributions welcome.",
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
