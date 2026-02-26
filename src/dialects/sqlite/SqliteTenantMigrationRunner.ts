import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import {
  ITenantMigrationRunner,
  TenantSyncResult,
} from "../ITenantMigrationRunner";

/**
 * SqliteTenantMigrationRunner
 *
 * SQLite는 스키마 기반 멀티테넌시를 지원하지 않습니다.
 * SQLite는 단일 파일 데이터베이스이므로 스키마 분리가 불가능합니다.
 *
 * 모든 메서드는 UnsupportedError를 throw합니다.
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
