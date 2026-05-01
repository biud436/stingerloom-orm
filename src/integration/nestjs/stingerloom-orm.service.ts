import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from "@nestjs/common";
import { EntityManager } from "../../core/EntityManager";
import { Logger } from "../../utils/Logger";
import type { ClazzType } from "../../utils/types";

export const STINGERLOOM_ORM_SERVICE_TOKEN = Symbol.for(
  "STINGERLOOM_ORM_SERVICE_TOKEN",
);

export function getOrmServiceToken(
  connectionName = "default",
): string | typeof StingerloomOrmService {
  if (connectionName === "default") return StingerloomOrmService;
  return `STINGERLOOM_ORM_SERVICE_${connectionName}`;
}

@Injectable()
export class StingerloomOrmService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(StingerloomOrmService.name);

  public static captured = {} as Record<
    typeof STINGERLOOM_ORM_SERVICE_TOKEN,
    boolean
  >;

  constructor(private readonly entityManager: EntityManager) {
    this.logger.info("StingerloomOrmService initialized");
  }

  async onModuleInit(): Promise<void> {
    this.logger.info("StingerloomOrmService OnModuleInit");

    if (
      !StingerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN]
    ) {
      this.logger.warn("StingerloomOrmModule.forRoot() was not called");
      return;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.propagateShutdown();
    } finally {
      StingerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN] = false;
      this.logger.info("Stingerloom ORM disconnected");
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
