import "reflect-metadata";
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { EntityManager, ClazzType, Logger } from "stingerloom-orm";
import Container from "typedi";
import {
  DATABASE_OPTION_TOKEN,
  DatabaseModule,
  DatabaseClientOptions,
} from "./database.module";

export const DATABASE_SERVICE_TOKEN = Symbol.for("DATABASE_SERVICE_TOKEN");

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private entityManager!: EntityManager;
  private readonly logger = new Logger(DatabaseService.name);

  public static captured = {} as Record<typeof DATABASE_SERVICE_TOKEN, boolean>;

  constructor() {
    this.logger.info("DatabaseService initialized");
  }

  async onModuleInit(): Promise<void> {
    this.logger.info("DatabaseService onModuleInit");

    // Check if this module was captured via forRoot()
    if (!DatabaseService.captured[DATABASE_SERVICE_TOKEN]) {
      this.logger.warn("DatabaseModule.forRoot() was not called");
      return;
    }

    await this.initEntityManager();
    await this.registerEntities();
  }

  async onModuleDestroy(): Promise<void> {
    await this.propagateShutdown();
    console.log("Database disconnected");
  }

  /**
   * Initialize EntityManager and register it in Container
   */
  private async initEntityManager(): Promise<void> {
    this.entityManager = new EntityManager();

    // Register EntityManager in typedi Container for dependency injection
    // Note: In NestJS we don't use InstanceScanner, but we can still store it in Container
    if (!Container.has(EntityManager)) {
      Container.set(EntityManager, this.entityManager);
    }
  }

  /**
   * Register entities with the database using metadata configuration
   */
  private async registerEntities(): Promise<void> {
    // Retrieve configuration from metadata (stored by DatabaseModule.forRoot())
    const options = Reflect.getMetadata(
      DATABASE_OPTION_TOKEN,
      DatabaseModule,
    ) as DatabaseClientOptions;

    if (!options) {
      throw new Error(
        "Database configuration is required. Did you call DatabaseModule.forRoot()?",
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
