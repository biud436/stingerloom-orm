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
import { Unit } from "../units/unit.entity";

/**
 * TenantSchemaService
 *
 * Delegates to the ORM's PostgresTenantMigrationRunner to
 * provision tenant schemas.
 *
 * The `tables` option can restrict which tables are replicated.
 * - include: specify replication targets via entity class or table name
 * - exclude: specify tables to exclude
 * - excludePrefix / excludeSuffix: exclude by prefix/suffix
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
          include: [User, Post, Unit],
        },
      };

      this.runner = new PostgresTenantMigrationRunner(driver, options);
    }
    return this.runner;
  }
}
