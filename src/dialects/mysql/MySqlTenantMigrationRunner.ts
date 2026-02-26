import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import {
  ITenantMigrationRunner,
  TenantSyncResult,
} from "../ITenantMigrationRunner";

/**
 * MySqlTenantMigrationRunner
 *
 * MySQL은 스키마 기반 멀티테넌시를 지원하지 않습니다.
 * MySQL의 "schema"는 "database"와 동의어이므로, PostgreSQL처럼
 * 하나의 데이터베이스 내에서 스키마를 분리하는 방식이 불가능합니다.
 *
 * 모든 메서드는 UnsupportedError를 throw합니다.
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
