import { DynamicModule, Module } from "@nestjs/common";
import { EntityManager } from "../../core/EntityManager";
import type { DatabaseClientOptions } from "../../core/DatabaseClientOptions";
import { getEntityManagerToken } from "./stingerloom-orm.module";

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
}
