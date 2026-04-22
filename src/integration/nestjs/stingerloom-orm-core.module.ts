import {
  DynamicModule,
  FactoryProvider,
  Module,
  Provider,
  Type,
} from "@nestjs/common";
import { EntityManager } from "../../core/EntityManager";
import type { DatabaseClientOptions } from "../../core/DatabaseClientOptions";
import { getEntityManagerToken } from "./stingerloom-orm.module";

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
    const optionsToken = getOrmOptionsToken(connectionName);

    const asyncProviders = StingerloomOrmCoreModule.createAsyncProviders(
      asyncOptions,
      optionsToken,
    );

    return {
      module: StingerloomOrmCoreModule,
      imports: asyncOptions.imports ?? [],
      providers: [
        ...asyncProviders,
        {
          provide: emToken,
          useFactory: async (options: DatabaseClientOptions) => {
            const em = new EntityManager();
            await em.register(options, connectionName);
            return em;
          },
          inject: [optionsToken],
        },
      ],
      exports: [emToken],
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
