import "reflect-metadata";
import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from "@nestjs/common";
import { EntityManager, ClazzType, Logger } from "@stingerloom/orm";
import Container from "typedi";

export const STINGERLOOM_ORM_SERVICE_TOKEN = Symbol.for(
  "STINGERLOOM_ORM_SERVICE_TOKEN",
);

@Injectable()
export class StinglerloomOrmService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(StinglerloomOrmService.name);

  public static captured = {} as Record<
    typeof STINGERLOOM_ORM_SERVICE_TOKEN,
    boolean
  >;

  constructor(private readonly entityManager: EntityManager) {
    this.logger.info("StinglerloomOrmService initialized");
  }

  async onModuleInit(): Promise<void> {
    this.logger.info("StinglerloomOrmService OnModuleInit");

    // Check if this module was captured via forRoot()
    if (
      !StinglerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN]
    ) {
      this.logger.warn("StinglerloomOrmModule.forRoot() was not called");
      return;
    }

    await this.initEntityManager();
    // register()는 EntityManager async factory에서 이미 완료됨
  }

  async onApplicationShutdown(): Promise<void> {
    await this.propagateShutdown();
    console.log("🔌 Stingerloom ORM disconnected");
  }

  /**
   * Initialize EntityManager and register it in Container
   */
  private async initEntityManager(): Promise<void> {
    // Register EntityManager in typedi Container for dependency injection
    if (!Container.has(EntityManager)) {
      Container.set(EntityManager, this.entityManager);
    }
  }

  /**
   * Shutdown database connections gracefully
   */
  private async propagateShutdown(): Promise<void> {
    if (this.entityManager) {
      await this.entityManager.propagateShutdown();
    }
  }

  /**
   * Get repository for a specific entity
   */
  getRepository<T>(entity: ClazzType<T>) {
    if (!this.entityManager) {
      throw new Error(
        "EntityManager not initialized. Database connection may not be ready.",
      );
    }
    return this.entityManager.getRepository(entity);
  }

  /**
   * Get the EntityManager instance
   */
  getEntityManager(): EntityManager {
    if (!this.entityManager) {
      throw new Error(
        "EntityManager not initialized. Database connection may not be ready.",
      );
    }
    return this.entityManager;
  }
}
