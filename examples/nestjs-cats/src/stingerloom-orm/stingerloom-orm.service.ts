import "reflect-metadata";
import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from "@nestjs/common";
import { EntityManager, ClazzType, Logger } from "@stingerloom/orm";
import Container from "typedi";
import {
  STINGERLOOM_ORM_OPTION_TOKEN,
  StinglerloomOrmModule,
  DatabaseClientOptions,
} from "./stingerloom-orm.module";

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
    await this.registerEntities();
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
   * Register entities with the database using metadata configuration
   */
  private async registerEntities(): Promise<void> {
    // Retrieve configuration from metadata (stored by StinglerloomOrmModule.forRoot())
    const options = Reflect.getMetadata(
      STINGERLOOM_ORM_OPTION_TOKEN,
      StinglerloomOrmModule,
    ) as DatabaseClientOptions;

    if (!options) {
      throw new Error(
        "Database configuration is required. Did you call StinglerloomOrmModule.forRoot()?",
      );
    }

    await this.entityManager.register(options);
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
