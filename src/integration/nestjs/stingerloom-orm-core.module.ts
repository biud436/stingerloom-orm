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
    const emToken = getEntityManagerToken(connectionName);
    const isDatabaseStrategy = options.tenantStrategy === "database";
    const mtemToken = getMultiTenantEntityManagerToken(connectionName);

    if (isDatabaseStrategy) {
      // One MTEM instance is the source of truth; the plain EntityManager
      // token resolves to its admin/public EM so existing @InjectEntityManager
      // call sites keep working for global tables.
      const mtemProvider: Provider = {
        provide: mtemToken,
        useFactory: async () => {
          const mtem = new MultiTenantEntityManager();
          await mtem.register(options);
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
    const emToken = getEntityManagerToken(connectionName);
    const mtemToken = getMultiTenantEntityManagerToken(connectionName);
    const optionsToken = getOrmOptionsToken(connectionName);

    const asyncProviders = StingerloomOrmCoreModule.createAsyncProviders(
      asyncOptions,
      optionsToken,
    );

    // The async path can't read tenantStrategy at module-construction time,
    // so we always provide the MTEM token as a lazy factory that no-ops when
    // the resolved options don't request the database strategy.
    const mtemProvider: Provider = {
      provide: mtemToken,
      useFactory: async (options: DatabaseClientOptions) => {
        if (options.tenantStrategy !== "database") {
          // Provide undefined so accidental @InjectMultiTenantEntityManager
          // usage on a non-database-strategy connection fails fast at
          // module-init rather than at first query.
          return undefined;
        }
        const mtem = new MultiTenantEntityManager();
        await mtem.register(options);
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
            if (options.tenantStrategy === "database" && mtem) {
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
