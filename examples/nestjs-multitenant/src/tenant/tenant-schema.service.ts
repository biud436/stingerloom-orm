import { Injectable } from "@nestjs/common";
import {
  EntityManager,
  PostgresTenantMigrationRunner,
  PostgresDriver,
  TenantMigrationRunnerOptions,
} from "@stingerloom/orm";
import { Inject } from "@nestjs/common";
import { User } from "../users/user.entity";
import { Post } from "../posts/post.entity";

/**
 * TenantSchemaService
 *
 * ORM의 PostgresTenantMigrationRunner에 위임하여
 * 테넌트 스키마를 프로비저닝합니다.
 *
 * `tables` 옵션으로 복제 대상 테이블을 제한할 수 있습니다.
 * - include: 엔티티 클래스 또는 테이블명으로 복제 대상 지정
 * - exclude: 제외할 테이블 지정
 * - excludePrefix / excludeSuffix: 접두사/접미사 기반 제외
 */
@Injectable()
export class TenantSchemaService {
  private runner: PostgresTenantMigrationRunner | null = null;

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

  private getRunner(): PostgresTenantMigrationRunner {
    if (!this.runner) {
      const driver = this.em.getDriver() as PostgresDriver;
      if (!driver) {
        throw new Error(
          "EntityManager driver not initialized. Ensure connect() has been called.",
        );
      }

      const options: TenantMigrationRunnerOptions = {
        // Only replicate User and Post tables to tenant schemas.
        // Any non-tenant tables in the public schema (e.g. shared config,
        // migration history) are excluded from provisioning.
        tables: {
          include: [User, Post],
        },
      };

      this.runner = new PostgresTenantMigrationRunner(driver, options);
    }
    return this.runner;
  }
}
