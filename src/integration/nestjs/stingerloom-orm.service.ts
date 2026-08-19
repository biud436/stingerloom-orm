import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from "@nestjs/common";
import { EntityManager } from "../../core/EntityManager";
import { MultiTenantEntityManager } from "../../core/MultiTenantEntityManager";
import { Logger } from "../../utils/Logger";
import type { ClazzType } from "../../utils/types";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

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

  constructor(
    private readonly entityManager: EntityManager,
    /**
     * Present only for `tenantStrategy: "database"`. The tenant EntityManagers
     * live inside it and are reachable from nowhere else, so shutdown has to
     * go through it rather than through the admin EntityManager the
     * `EntityManager` token resolves to.
     */
    private readonly multiTenantEntityManager?: MultiTenantEntityManager,
    private readonly connectionName: string = "default",
  ) {
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
      this.logger.info(
        `Stingerloom ORM disconnected (connection "${this.connectionName}")`,
      );
    } catch (err: unknown) {
      // The old code logged "disconnected" from a `finally`, so a failed
      // shutdown read exactly like a clean one. The error still propagates to
      // `app.close()` — a caller that awaits it deserves to know the pool was
      // not released.
      this.logger.error(
        `Stingerloom ORM shutdown failed for connection "${this.connectionName}": ${
          err instanceof Error ? err.message : String(err)
        }. Connections may still be open.`,
      );
      throw err;
    } finally {
      StingerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN] = false;
    }
  }

  /**
   * Closes what this module opened.
   *
   * `closeConnections` defaults to false in the core API because a library
   * consumer may own the pool and keep using it after tearing down an
   * EntityManager. Inside a Nest application the module owns the pool it
   * registered, and `onApplicationShutdown` means the process is going away —
   * so the shutdown asks for the pool to be closed. Each EntityManager closes
   * only its own `connectionName` in the `DatabaseClient` registry, so a second
   * `forRoot()` under a different connection name is untouched.
   */
  private async propagateShutdown(): Promise<void> {
    const options = { closeConnections: true };

    // `instanceof` rather than a truthiness check: forRootAsync always provides
    // the MTEM token and substitutes a misuse sentinel for non-database
    // strategies, whose methods throw when called.
    if (this.multiTenantEntityManager instanceof MultiTenantEntityManager) {
      await this.multiTenantEntityManager.propagateShutdown(options);
      return;
    }

    if (this.entityManager) {
      await this.entityManager.propagateShutdown(options);
    }
  }

  getRepository<T>(entity: ClazzType<T>) {
    if (!this.entityManager) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "EntityManager not initialized. Database connection may not be ready.",
      );
    }
    return this.entityManager.getRepository(entity);
  }

  getEntityManager(): EntityManager {
    if (!this.entityManager) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        "EntityManager not initialized. Database connection may not be ready.",
      );
    }
    return this.entityManager;
  }
}
