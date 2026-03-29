import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from "@nestjs/common";
import { EntityManager } from "../../core/EntityManager";
import { Logger } from "../../utils/Logger";
import type { ClazzType } from "../../utils/types";
// Lightweight global registry for NestJS EntityManager injection
const globalRegistry = new Map<Function, unknown>();

export const STINGERLOOM_ORM_SERVICE_TOKEN = Symbol.for(
  "STINGERLOOM_ORM_SERVICE_TOKEN",
);

export function getOrmServiceToken(
  connectionName = "default",
): string | typeof StinglerloomOrmService {
  if (connectionName === "default") return StinglerloomOrmService;
  return `STINGERLOOM_ORM_SERVICE_${connectionName}`;
}

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

    if (
      !StinglerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN]
    ) {
      this.logger.warn("StinglerloomOrmModule.forRoot() was not called");
      return;
    }

    await this.initEntityManager();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.propagateShutdown();
    this.logger.info("Stingerloom ORM disconnected");
  }

  private async initEntityManager(): Promise<void> {
    if (!globalRegistry.has(EntityManager)) {
      globalRegistry.set(EntityManager, this.entityManager);
    }
  }

  private async propagateShutdown(): Promise<void> {
    if (this.entityManager) {
      await this.entityManager.propagateShutdown();
    }
  }

  getRepository<T>(entity: ClazzType<T>) {
    if (!this.entityManager) {
      throw new Error(
        "EntityManager not initialized. Database connection may not be ready.",
      );
    }
    return this.entityManager.getRepository(entity);
  }

  getEntityManager(): EntityManager {
    if (!this.entityManager) {
      throw new Error(
        "EntityManager not initialized. Database connection may not be ready.",
      );
    }
    return this.entityManager;
  }
}
