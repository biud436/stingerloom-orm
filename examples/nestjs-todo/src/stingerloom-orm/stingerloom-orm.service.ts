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

  constructor(private readonly entityManager: EntityManager) {}

  async onModuleInit(): Promise<void> {
    if (!StinglerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN]) {
      return;
    }
    if (!Container.has(EntityManager)) {
      Container.set(EntityManager, this.entityManager);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.entityManager) {
      await this.entityManager.propagateShutdown();
    }
  }

  getRepository<T>(entity: ClazzType<T>) {
    return this.entityManager.getRepository(entity);
  }

  getEntityManager(): EntityManager {
    return this.entityManager;
  }
}
