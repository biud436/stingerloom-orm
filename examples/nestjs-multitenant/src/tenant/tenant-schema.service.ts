import { Injectable } from "@nestjs/common";
import {
  EntityManager,
  TenantMigrationRunner,
  PostgresDriver,
} from "stingerloom-orm";
import { Inject } from "@nestjs/common";

/**
 * TenantSchemaService
 *
 * ORM 코어의 TenantMigrationRunner에 위임하여
 * 테넌트 스키마를 프로비저닝합니다.
 */
@Injectable()
export class TenantSchemaService {
  private runner: TenantMigrationRunner | null = null;

  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  /**
   * Ensures the tenant's schema exists with all required tables.
   * No-op for "public" tenant or already-provisioned schemas.
   */
  async ensureSchema(tenantId: string): Promise<void> {
    const runner = this.getRunner();
    return runner.ensureSchema(tenantId);
  }

  private getRunner(): TenantMigrationRunner {
    if (!this.runner) {
      const driver = this.em.getDriver() as PostgresDriver;
      if (!driver) {
        throw new Error(
          "EntityManager driver not initialized. Ensure connect() has been called.",
        );
      }
      this.runner = new TenantMigrationRunner(driver);
    }
    return this.runner;
  }
}
