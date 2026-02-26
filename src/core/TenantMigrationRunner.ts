/* eslint-disable @typescript-eslint/no-explicit-any */
import { PostgresDriver } from "../dialects/postgres/PostgresDriver";
import { Logger } from "../utils";

export interface TenantMigrationRunnerOptions {
  /**
   * 테이블 구조를 복제할 원본 스키마. 기본값: "public"
   */
  sourceSchema?: string;
}

export interface TenantSyncResult {
  /** 새로 생성된 스키마 목록 */
  created: string[];
  /** 이미 존재하여 건너뛴 스키마 목록 */
  skipped: string[];
}

/**
 * TenantMigrationRunner
 *
 * PostgreSQL 스키마 기반 멀티테넌시를 위한 마이그레이션 러너입니다.
 * ORM 시작 시 모든 테넌트 스키마를 자동으로 검사하고,
 * 존재하지 않는 스키마를 원본(기본 public) 스키마 구조를 복제하여 생성합니다.
 *
 * `LIKE ... INCLUDING ALL`을 사용하여 컬럼, PK, 인덱스, 제약 조건을 모두 복제합니다.
 * 데이터는 복제하지 않습니다.
 */
export class TenantMigrationRunner {
  private readonly provisionedSchemas = new Set<string>();
  private readonly provisioningLocks = new Map<string, Promise<void>>();
  private readonly sourceSchema: string;
  private readonly logger = new Logger("TenantMigrationRunner");

  constructor(
    private readonly driver: PostgresDriver,
    options?: TenantMigrationRunnerOptions,
  ) {
    this.sourceSchema = options?.sourceSchema ?? "public";
  }

  /**
   * 데이터베이스에 존재하는 모든 사용자 정의 스키마 목록을 반환합니다.
   * 시스템 스키마(pg_*, information_schema)는 제외됩니다.
   */
  async discoverSchemas(): Promise<string[]> {
    const rows = await this.driver.listSchemas();
    return (rows as any[]).map((r) => r.schema_name);
  }

  /**
   * 단일 테넌트 스키마를 프로비저닝합니다.
   * 이미 프로비저닝된 경우 no-op입니다.
   *
   * 동시 요청 시 동일 테넌트에 대한 중복 DDL을 방지하는
   * 프로비저닝 잠금을 사용합니다.
   */
  async ensureSchema(tenantId: string): Promise<void> {
    if (
      tenantId === this.sourceSchema ||
      this.provisionedSchemas.has(tenantId)
    ) {
      return;
    }

    // 동일 테넌트에 대한 동시 프로비저닝 방지
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

  /**
   * 주어진 테넌트 ID 목록에 대해 모든 스키마를 일괄 프로비저닝합니다.
   * 이미 존재하는 스키마는 건너뛰고, 존재하지 않는 스키마만 생성합니다.
   *
   * @returns 생성된 스키마와 건너뛴 스키마 목록
   */
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

  /**
   * 특정 테넌트 스키마가 프로비저닝되었는지 확인합니다.
   */
  isProvisioned(tenantId: string): boolean {
    return this.provisionedSchemas.has(tenantId);
  }

  /**
   * 현재까지 프로비저닝된 모든 스키마 이름을 반환합니다.
   */
  getProvisionedSchemas(): string[] {
    return Array.from(this.provisionedSchemas);
  }

  /**
   * 내부 프로비저닝 상태를 초기화합니다 (테스트용).
   */
  reset(): void {
    this.provisionedSchemas.clear();
    this.provisioningLocks.clear();
  }

  private async provision(tenantId: string): Promise<void> {
    // 1. 스키마 생성
    await this.driver.createSchema(tenantId);

    // 2. 원본 스키마의 테이블 목록 조회
    const tables = await this.driver.listTables(this.sourceSchema);

    // 3. 각 테이블 구조를 테넌트 스키마로 복제 (LIKE ... INCLUDING ALL)
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
