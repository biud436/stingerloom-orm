import {
  DynamicModule,
  FactoryProvider,
  Module,
  Provider,
  Type,
} from "@nestjs/common";
import { EntityManager } from "../../core/EntityManager";
import { MultiTenantEntityManager } from "../../core/MultiTenantEntityManager";
import type { DatabaseClientOptions } from "../../core/DatabaseClientOptions";
import { getEntityManagerToken } from "./stingerloom-orm.module";
import { getMultiTenantEntityManagerToken } from "./inject-multi-tenant-entity-manager.decorator";
import { recordOrmConnectionName } from "./connection-name-registry";

export interface StingerloomOrmOptionsFactory {
  createStingerloomOrmOptions():
    | Promise<DatabaseClientOptions>
    | DatabaseClientOptions;
}

export interface StingerloomOrmModuleAsyncOptions {
  imports?: DynamicModule["imports"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory?: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ) => Promise<DatabaseClientOptions> | DatabaseClientOptions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inject?: any[];
  useClass?: Type<StingerloomOrmOptionsFactory>;
  useExisting?: Type<StingerloomOrmOptionsFactory>;
  connectionName?: string;
}

export function getOrmOptionsToken(connectionName = "default"): string {
  return connectionName === "default"
    ? "STINGERLOOM_ORM_OPTIONS"
    : `STINGERLOOM_ORM_OPTIONS_${connectionName}`;
}

@Module({})
export class StingerloomOrmCoreModule {
  static forRoot(
    options: DatabaseClientOptions,
    connectionName = "default",
  ): DynamicModule {
    recordOrmConnectionName(connectionName);
    const emToken = getEntityManagerToken(connectionName);
    const isDatabaseStrategy = options.tenantStrategy === "database";
    const mtemToken = getMultiTenantEntityManagerToken(connectionName);

    if (isDatabaseStrategy) {
      // One MTEM instance is the source of truth; the plain EntityManager
      // token resolves to its admin/public EM so existing @InjectEntityManager
      // call sites keep working for global tables. Pass the Nest connectionName
      // to mtem.register() so multiple MTEM instances (named connections) get
      // distinct admin pools and don't stomp each other's "default" connector.
      const mtemProvider: Provider = {
        provide: mtemToken,
        useFactory: async () => {
          const mtem = new MultiTenantEntityManager();
          await mtem.register(options, connectionName);
          return mtem;
        },
      };
      const emProvider: Provider = {
        provide: emToken,
        useFactory: (mtem: MultiTenantEntityManager) =>
          mtem.getDefaultEntityManager(),
        inject: [mtemToken],
      };
      return {
        module: StingerloomOrmCoreModule,
        providers: [mtemProvider, emProvider],
        exports: [emToken, mtemToken],
      };
    }

    return {
      module: StingerloomOrmCoreModule,
      providers: [
        {
          provide: emToken,
          useFactory: async () => {
            const em = new EntityManager();
            await em.register(options, connectionName);
            return em;
          },
        },
      ],
      exports: [emToken],
    };
  }

  static forRootAsync(
    asyncOptions: StingerloomOrmModuleAsyncOptions,
  ): DynamicModule {
    const connectionName = asyncOptions.connectionName ?? "default";
    recordOrmConnectionName(connectionName);
    const emToken = getEntityManagerToken(connectionName);
    const mtemToken = getMultiTenantEntityManagerToken(connectionName);
    const optionsToken = getOrmOptionsToken(connectionName);

    const asyncProviders = StingerloomOrmCoreModule.createAsyncProviders(
      asyncOptions,
      optionsToken,
    );

    // The async path can't read tenantStrategy at module-construction time,
    // so we always provide the MTEM token. When the resolved options don't
    // request the database strategy we still provide a value, but it's a
    // Proxy sentinel that throws on any access — that way an accidental
    // `@InjectMultiTenantEntityManager()` on a non-database-strategy
    // connection fails with a clear, actionable error at first use instead
    // of a confusing `Cannot read properties of undefined`.
    const mtemProvider: Provider = {
      provide: mtemToken,
      useFactory: async (options: DatabaseClientOptions) => {
        if (options.tenantStrategy !== "database") {
          return makeMtemMisuseSentinel(connectionName);
        }
        const mtem = new MultiTenantEntityManager();
        await mtem.register(options, connectionName);
        return mtem;
      },
      inject: [optionsToken],
    };

    return {
      module: StingerloomOrmCoreModule,
      imports: asyncOptions.imports ?? [],
      providers: [
        ...asyncProviders,
        mtemProvider,
        {
          provide: emToken,
          useFactory: async (
            options: DatabaseClientOptions,
            mtem?: MultiTenantEntityManager,
          ) => {
            if (options.tenantStrategy === "database") {
              // Strategy is "database" — every query MUST go through MTEM.
              // A missing MTEM here means our module wiring is broken; fall
              // through to a plain EntityManager would silently route every
              // tenant query to the admin DB, which is exactly the kind of
              // wiring bug we want to surface immediately.
              if (!mtem || isMtemMisuseSentinel(mtem)) {
                throw new Error(
                  `[StingerloomOrmModule] MultiTenantEntityManager provider is required when tenantStrategy is "database" (connection "${connectionName}"). This usually indicates broken module wiring.`,
                );
              }
              return mtem.getDefaultEntityManager();
            }
            const em = new EntityManager();
            await em.register(options, connectionName);
            return em;
          },
          inject: [optionsToken, mtemToken],
        },
      ],
      exports: [emToken, mtemToken],
    };
  }

  private static createAsyncProviders(
    asyncOptions: StingerloomOrmModuleAsyncOptions,
    optionsToken: string,
  ): Provider[] {
    if (asyncOptions.useFactory) {
      return [
        {
          provide: optionsToken,
          useFactory: asyncOptions.useFactory,
          inject: (asyncOptions.inject ??
            []) as FactoryProvider["inject"],
        },
      ];
    }

    if (asyncOptions.useExisting) {
      return [
        {
          provide: optionsToken,
          useFactory: (factory: StingerloomOrmOptionsFactory) =>
            factory.createStingerloomOrmOptions(),
          inject: [asyncOptions.useExisting],
        },
      ];
    }

    if (asyncOptions.useClass) {
      return [
        {
          provide: asyncOptions.useClass,
          useClass: asyncOptions.useClass,
        },
        {
          provide: optionsToken,
          useFactory: (factory: StingerloomOrmOptionsFactory) =>
            factory.createStingerloomOrmOptions(),
          inject: [asyncOptions.useClass],
        },
      ];
    }

    throw new Error(
      "StingerloomOrmModule.forRootAsync() requires one of useFactory, useClass, or useExisting",
    );
  }
}

const MTEM_MISUSE_SENTINEL = Symbol.for(
  "stingerloom.mtem.misuse-sentinel",
);

/**
 * Returns a misuse sentinel that mirrors `MultiTenantEntityManager`'s
 * public API but where every method throws a clear error explaining that
 * MTEM is only available when `tenantStrategy: "database"`. Used by
 * `forRootAsync` so the MTEM token can always be provided (Nest can't
 * conditionally omit a token at module-construction time when the options
 * come from an async factory), but accidental use of
 * `@InjectMultiTenantEntityManager()` on a non-database connection fails
 * fast with an actionable message at the first real call instead of a
 * confusing `Cannot read properties of undefined`.
 *
 * Why a plain object rather than a `Proxy`: NestJS dispatches a lot of
 * generic property probes against every resolved provider value
 * (lifecycle-hook detection like `instance.onModuleInit`, `util.inspect`,
 * `instanceof` checks, the dependency-graph inspector, etc.). A throwing
 * Proxy `get` trap turns those benign probes into bootstrap crashes the
 * moment the MTEM token is resolved — which `forRootAsync` does
 * unconditionally because `emToken` injects it. Materializing the
 * sentinel as a plain object means unknown properties read as a normal
 * `undefined` (so probes pass through), while the known MTEM methods
 * still throw the actionable misuse error when actually called.
 */
function makeMtemMisuseSentinel(
  connectionName: string,
): MultiTenantEntityManager {
  const error = new Error(
    `[StingerloomOrmModule] @InjectMultiTenantEntityManager() is only available when tenantStrategy is "database" (connection "${connectionName}"). Either pass tenantStrategy: "database" in your options factory, or remove the @InjectMultiTenantEntityManager() injection from this connection.`,
  );
  const throwingMethod = (): never => {
    throw error;
  };
  const sentinel: Record<string | symbol, unknown> = {
    [MTEM_MISUSE_SENTINEL]: true,
  };
  for (const key of Object.getOwnPropertyNames(
    MultiTenantEntityManager.prototype,
  )) {
    if (key === "constructor") continue;
    sentinel[key] = throwingMethod;
  }
  return sentinel as unknown as MultiTenantEntityManager;
}

function isMtemMisuseSentinel(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  try {
    return (value as Record<symbol, unknown>)[MTEM_MISUSE_SENTINEL] === true;
  } catch {
    return false;
  }
}
