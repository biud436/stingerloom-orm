import { DynamicModule, Module } from "@nestjs/common";
import {
  StingerloomOrmService,
  STINGERLOOM_ORM_SERVICE_TOKEN,
  getOrmServiceToken,
} from "./stingerloom-orm.service";
import { EntityManager } from "../../core/EntityManager";
import type { ClazzType } from "../../utils/types";
import type { DatabaseClientOptions } from "../../core/DatabaseClientOptions";
import {
  StingerloomOrmCoreModule,
  type StingerloomOrmModuleAsyncOptions,
} from "./stingerloom-orm-core.module";

export const STINGERLOOM_ORM_OPTION_TOKEN = Symbol.for(
  "STINGERLOOM_ORM_OPTION_TOKEN",
);
export const INJECT_REPOSITORIES_TOKEN = "INJECT_REPOSITORIES_TOKEN";

export function getEntityManagerToken(
  connectionName = "default",
): string | typeof EntityManager {
  if (connectionName === "default") return EntityManager;
  return `STINGERLOOM_ENTITY_MANAGER_${connectionName}`;
}

const repositoryTokenCacheByConnection = new Map<
  string,
  WeakMap<ClazzType<unknown>, symbol>
>();

export function makeInjectRepositoryToken(
  entity: ClazzType<unknown>,
  connectionName = "default",
): symbol {
  let connCache = repositoryTokenCacheByConnection.get(connectionName);
  if (!connCache) {
    connCache = new WeakMap();
    repositoryTokenCacheByConnection.set(connectionName, connCache);
  }
  let token = connCache.get(entity);
  if (!token) {
    const suffix = connectionName === "default" ? "" : `_${connectionName}`;
    token = Symbol(`${INJECT_REPOSITORIES_TOKEN}_${entity.name}${suffix}`);
    connCache.set(entity, token);
  }
  return token;
}

@Module({})
export class StingerloomOrmModule {
  static forFeature(
    entities: ClazzType<unknown>[],
    connectionName = "default",
  ): DynamicModule {
    const emToken = getEntityManagerToken(connectionName);
    const providers = entities.map((entity) => ({
      provide: makeInjectRepositoryToken(entity, connectionName),
      useFactory: (entityManager: EntityManager) => {
        return entityManager.getRepository(entity);
      },
      inject: [emToken],
    }));

    return {
      module: StingerloomOrmModule,
      providers: [...providers],
      exports: providers,
    };
  }

  static forRoot(
    options: DatabaseClientOptions,
    connectionName = "default",
  ): DynamicModule {
    Reflect.defineMetadata(
      STINGERLOOM_ORM_OPTION_TOKEN,
      options,
      StingerloomOrmModule,
    );

    StingerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN] = true;

    const emToken = getEntityManagerToken(connectionName);
    const serviceToken = getOrmServiceToken(connectionName);

    return {
      module: StingerloomOrmModule,
      imports: [StingerloomOrmCoreModule.forRoot(options, connectionName)],
      providers: [
        {
          provide: serviceToken,
          useFactory: (em: EntityManager) => new StingerloomOrmService(em),
          inject: [emToken],
        },
      ],
      exports: [serviceToken, StingerloomOrmCoreModule],
      global: true,
    };
  }

  static forRootAsync(
    asyncOptions: StingerloomOrmModuleAsyncOptions,
  ): DynamicModule {
    const connectionName = asyncOptions.connectionName ?? "default";

    StingerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN] = true;

    const emToken = getEntityManagerToken(connectionName);
    const serviceToken = getOrmServiceToken(connectionName);

    return {
      module: StingerloomOrmModule,
      imports: [StingerloomOrmCoreModule.forRootAsync(asyncOptions)],
      providers: [
        {
          provide: serviceToken,
          useFactory: (em: EntityManager) => new StingerloomOrmService(em),
          inject: [emToken],
        },
      ],
      exports: [serviceToken, StingerloomOrmCoreModule],
      global: true,
    };
  }
}
