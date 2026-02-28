import { DynamicModule, Module } from "@nestjs/common";
import {
  StinglerloomOrmService,
  STINGERLOOM_ORM_SERVICE_TOKEN,
} from "./stingerloom-orm.service";
import {
  EntityManager,
  type ClazzType,
  type DatabaseClientOptions,
} from "@stingerloom/orm";
import { StingerloomOrmCoreModule } from "./stingerloom-orm.core.module";

export type { DatabaseClientOptions } from "@stingerloom/orm";

export const STINGERLOOM_ORM_OPTION_TOKEN = Symbol.for(
  "STINGERLOOM_ORM_OPTION_TOKEN",
);
export const INJECT_REPOSITORIES_TOKEN = "INJECT_REPOSITORIES_TOKEN";

const repositoryTokenCache = new WeakMap<ClazzType<unknown>, symbol>();

export function makeInjectRepositoryToken(entity: ClazzType<unknown>): symbol {
  let token = repositoryTokenCache.get(entity);

  if (!token) {
    token = Symbol(`${INJECT_REPOSITORIES_TOKEN}_${entity.name}`);
    repositoryTokenCache.set(entity, token);
  }

  return token;
}

@Module({})
export class StinglerloomOrmModule {
  static forFeature(entities: ClazzType<unknown>[]): DynamicModule {
    const providers = entities.map((entity) => ({
      provide: makeInjectRepositoryToken(entity),
      useFactory: (entityManager: EntityManager) => {
        return entityManager.getRepository(entity);
      },
      inject: [EntityManager],
    }));

    return {
      module: StinglerloomOrmModule,
      providers: [...providers],
      exports: providers,
    };
  }

  static forRoot(options: DatabaseClientOptions): DynamicModule {
    Reflect.defineMetadata(
      STINGERLOOM_ORM_OPTION_TOKEN,
      options,
      StinglerloomOrmModule,
    );

    StinglerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN] = true;

    return {
      module: StinglerloomOrmModule,
      imports: [StingerloomOrmCoreModule.forRoot()],
      providers: [StinglerloomOrmService],
      exports: [StinglerloomOrmService, StingerloomOrmCoreModule],
      global: true,
    };
  }
}
