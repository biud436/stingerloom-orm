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
import { MultiTenantEntityManager } from "../../core/MultiTenantEntityManager";
import { getMultiTenantEntityManagerToken } from "./inject-multi-tenant-entity-manager.decorator";
import { getRecordedOrmConnectionNames } from "./connection-name-registry";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { closestIdentifier } from "../../utils/closestIdentifier";

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
    const featureArgs =
      connectionName === "default"
        ? `[${entity.name}]`
        : `[${entity.name}], "${connectionName}"`;
    // The remediation rides in the symbol description so Nest's generic
    // "can't resolve dependencies (?)" error names the fix by itself.
    token = Symbol(
      `${INJECT_REPOSITORIES_TOKEN}_${entity.name}${suffix} ` +
        `(provided by StingerloomOrmModule.forFeature(${featureArgs}) — import it in this module)`,
    );
    connCache.set(entity, token);
  }
  return token;
}

/**
 * Built when a `forFeature()` repository factory finds no EntityManager under
 * its connection name — i.e. no `forRoot()`/`forRootAsync()` registered that
 * name (typo or missing root module).
 */
function makeUnknownConnectionError(
  entity: ClazzType<unknown>,
  connectionName: string,
): OrmError {
  const known = getRecordedOrmConnectionNames();
  const suggestion = closestIdentifier(connectionName, known);
  return new OrmError(
    OrmErrorCode.INVALID_CONFIG,
    `StingerloomOrmModule.forFeature([${entity.name}], "${connectionName}") could not resolve its EntityManager: ` +
      `no forRoot()/forRootAsync() registered a connection named "${connectionName}". ` +
      `Known connections: ${known.length > 0 ? known.map((n) => `"${n}"`).join(", ") : "(none)"}.` +
      (suggestion ? ` Did you mean "${suggestion}"?` : ""),
    `Fix the connectionName passed to forFeature(), or add StingerloomOrmModule.forRoot(options, "${connectionName}") to your root module.`,
  );
}

@Module({})
export class StingerloomOrmModule {
  static forFeature(
    entities: ClazzType<unknown>[],
    connectionName = "default",
  ): DynamicModule {
    const emToken = getEntityManagerToken(connectionName);
    // The EntityManager is injected as optional: with a required token a
    // connectionName typo dies inside Nest's resolver with a generic
    // "can't resolve dependencies (?)" — the factory never runs. Optional
    // injection lets the factory fire and raise an OrmError that names the
    // missing connection and the ones that actually exist.
    const providers = entities.map((entity) => ({
      provide: makeInjectRepositoryToken(entity, connectionName),
      useFactory: (entityManager?: EntityManager) => {
        if (!entityManager) {
          throw makeUnknownConnectionError(entity, connectionName);
        }
        return entityManager.getRepository(entity);
      },
      inject: [{ token: emToken, optional: true }],
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
    StingerloomOrmService.captured[STINGERLOOM_ORM_SERVICE_TOKEN] = true;

    const emToken = getEntityManagerToken(connectionName);
    const serviceToken = getOrmServiceToken(connectionName);
    // Under "database" the core module provides the MTEM token, and the tenant
    // EntityManagers hang off it — the service needs it to close their pools.
    const injectTokens =
      options.tenantStrategy === "database"
        ? [emToken, getMultiTenantEntityManagerToken(connectionName)]
        : [emToken];

    return {
      module: StingerloomOrmModule,
      imports: [StingerloomOrmCoreModule.forRoot(options, connectionName)],
      providers: [
        {
          provide: serviceToken,
          useFactory: (em: EntityManager, mtem?: MultiTenantEntityManager) =>
            new StingerloomOrmService(em, mtem, connectionName),
          inject: injectTokens,
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
    // forRootAsync always provides the MTEM token (the strategy is unknown at
    // module-construction time); for non-database strategies it resolves to a
    // misuse sentinel, which the service filters out with an instanceof check.
    const mtemToken = getMultiTenantEntityManagerToken(connectionName);

    return {
      module: StingerloomOrmModule,
      imports: [StingerloomOrmCoreModule.forRootAsync(asyncOptions)],
      providers: [
        {
          provide: serviceToken,
          useFactory: (em: EntityManager, mtem?: MultiTenantEntityManager) =>
            new StingerloomOrmService(em, mtem, connectionName),
          inject: [emToken, mtemToken],
        },
      ],
      exports: [serviceToken, StingerloomOrmCoreModule],
      global: true,
    };
  }
}
