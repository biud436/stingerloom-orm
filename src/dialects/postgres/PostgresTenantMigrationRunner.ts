/* eslint-disable @typescript-eslint/no-explicit-any */
import { PostgresDriver } from "./PostgresDriver";
import { Logger } from "../../utils";
import {
  ITenantMigrationRunner,
  TenantMigrationRunnerOptions,
  TenantSyncResult,
} from "../ITenantMigrationRunner";

/**
 * PostgresTenantMigrationRunner
 *
 * PostgreSQL 스키마 기반 멀티테넌시를 위한 마이그레이션 러너입니다.
 * ORM 시작 시 모든 테넌트 스키마를 자동으로 검사하고,
 * 존재하지 않는 스키마를 원본(기본 public) 스키마 구조를 복제하여 생성합니다.
 *
 * `LIKE ... INCLUDING ALL`을 사용하여 컬럼, PK, 인덱스, 제약 조건을 모두 복제합니다.
 * 데이터는 복제하지 않습니다.
 */
export class PostgresTenantMigrationRunner implements ITenantMigrationRunner {
  private readonly provisionedSchemas = new Set<string>();
  private readonly provisioningLocks = new Map<string, Promise<void>>();
  private readonly sourceSchema: string;
  private readonly logger = new Logger("PostgresTenantMigrationRunner");

  constructor(
    private readonly driver: PostgresDriver,
    options?: TenantMigrationRunnerOptions,
  ) {
    this.sourceSchema = options?.sourceSchema ?? "public";
  }

  async discoverSchemas(): Promise<string[]> {
    const rows = await this.driver.listSchemas();
    return (rows as any[]).map((r) => r.schema_name);
  }

  async ensureSchema(tenantId: string): Promise<void> {
    if (
      tenantId === this.sourceSchema ||
      this.provisionedSchemas.has(tenantId)
    ) {
      return;
    }

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

  async syncTenantSchemas(tenantIds: string[]): Promise<TenantSyncResult> {
    const existingSchemas = new Set(await this.discoverSchemas());
    const created: string[] = [];
    const skipped: string[] = [];

    for (const tenantId of tenantIds) {
      if (tenantId === this.sourceSchema) {
        skipped.push(tenantId);
        continue;
      }

      if (existingSchemas.has(tenantId)) {
        this.provisionedSchemas.add(tenantId);
        skipped.push(tenantId);
        continue;
      }

      this.logger.info(`Provisioning schema: ${tenantId}`);
      await this.provision(tenantId);
      this.provisionedSchemas.add(tenantId);
      created.push(tenantId);
    }

    return { created, skipped };
  }

  isProvisioned(tenantId: string): boolean {
    return this.provisionedSchemas.has(tenantId);
  }

  getProvisionedSchemas(): string[] {
    return Array.from(this.provisionedSchemas);
  }

  reset(): void {
    this.provisionedSchemas.clear();
    this.provisioningLocks.clear();
  }

  private async provision(tenantId: string): Promise<void> {
    await this.driver.createSchema(tenantId);

    const tables = await this.driver.listTables(this.sourceSchema);

    for (const row of tables as any[]) {
      const tableName = row.tablename as string;
      const escapedTenant = tenantId.replace(/"/g, '""');
      const escapedTable = tableName.replace(/"/g, '""');
      const escapedSource = this.sourceSchema.replace(/"/g, '""');

      await this.driver.executeRaw(
        `CREATE TABLE IF NOT EXISTS "${escapedTenant}"."${escapedTable}" (LIKE "${escapedSource}"."${escapedTable}" INCLUDING ALL)`,
      );
    }

    this.logger.info(
      `Schema "${tenantId}" provisioned with ${(tables as any[]).length} tables`,
    );
  }
}
