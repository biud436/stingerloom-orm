/* eslint-disable @typescript-eslint/no-explicit-any */
import { PostgresDriver } from "./PostgresDriver";
import { Logger } from "../../utils";
import {
  ITenantMigrationRunner,
  TenantMigrationRunnerOptions,
  TenantTableFilterOptions,
  TenantSyncResult,
} from "../ITenantMigrationRunner";
import { ENTITY_TOKEN, EntityMetadata } from "../../decorators/Entity";

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
  private readonly tableFilter: TenantTableFilterOptions | undefined;
  private readonly logger = new Logger("PostgresTenantMigrationRunner");

  constructor(
    private readonly driver: PostgresDriver,
    options?: TenantMigrationRunnerOptions,
  ) {
    this.sourceSchema = options?.sourceSchema ?? "public";
    this.tableFilter = options?.tables;
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

    const promise = this.provision(tenantId)
      .then(() => {
        this.provisionedSchemas.add(tenantId);
      })
      .catch((err) => {
        this.logger.error(
          `Failed to provision schema "${tenantId}": ${err.message}`,
        );
        throw err;
      })
      .finally(() => {
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
    const allTableNames = (tables as any[]).map((r) => r.tablename as string);
    const filtered = this.filterTables(allTableNames);

    for (const tableName of filtered) {
      const wrappedTenant = this.driver.wrap(tenantId);
      const wrappedTable = this.driver.wrap(tableName);
      const wrappedSource = this.driver.wrap(this.sourceSchema);

      await this.driver.executeRaw(
        `CREATE TABLE IF NOT EXISTS ${wrappedTenant}.${wrappedTable} (LIKE ${wrappedSource}.${wrappedTable} INCLUDING ALL)`,
      );
    }

    this.logger.info(
      `Schema "${tenantId}" provisioned with ${filtered.length} tables`,
    );
  }

  /**
   * 엔티티 클래스 또는 문자열에서 테이블명을 추출합니다.
   */
  private resolveTableName(item: string | Function): string {
    if (typeof item === "string") return item;
    const meta = Reflect.getMetadata(ENTITY_TOKEN, item) as
      | EntityMetadata
      | undefined;
    if (meta?.name) return meta.name;
    return item.name;
  }

  /**
   * TenantTableFilterOptions에 따라 테이블 목록을 필터링합니다.
   *
   * 적용 순서:
   * 1. include → 지정 시 해당 테이블만 후보
   * 2. includePrefix / includeSuffix → 추가로 좁힘
   * 3. exclude → 제외
   * 4. excludePrefix / excludeSuffix → 추가 제외
   */
  private filterTables(tableNames: string[]): string[] {
    const opts = this.tableFilter;
    if (!opts) return tableNames;

    let result = tableNames;

    // 1. include (빈 배열이면 아무것도 포함하지 않음)
    if (opts.include) {
      const includeSet = new Set(
        opts.include.map((item) => this.resolveTableName(item)),
      );
      result = result.filter((t) => includeSet.has(t));
    }

    // 2. includePrefix / includeSuffix
    if (opts.includePrefix && opts.includePrefix.length > 0) {
      result = result.filter((t) =>
        opts.includePrefix!.some((p) => t.startsWith(p)),
      );
    }
    if (opts.includeSuffix && opts.includeSuffix.length > 0) {
      result = result.filter((t) =>
        opts.includeSuffix!.some((s) => t.endsWith(s)),
      );
    }

    // 3. exclude
    if (opts.exclude && opts.exclude.length > 0) {
      const excludeSet = new Set(
        opts.exclude.map((item) => this.resolveTableName(item)),
      );
      result = result.filter((t) => !excludeSet.has(t));
    }

    // 4. excludePrefix / excludeSuffix
    if (opts.excludePrefix && opts.excludePrefix.length > 0) {
      result = result.filter(
        (t) => !opts.excludePrefix!.some((p) => t.startsWith(p)),
      );
    }
    if (opts.excludeSuffix && opts.excludeSuffix.length > 0) {
      result = result.filter(
        (t) => !opts.excludeSuffix!.some((s) => t.endsWith(s)),
      );
    }

    return result;
  }
}
