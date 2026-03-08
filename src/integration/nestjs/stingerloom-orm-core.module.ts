import { DynamicModule, Module } from "@nestjs/common";
import { EntityManager } from "../../core/EntityManager";
import type { DatabaseClientOptions } from "../../core/DatabaseClientOptions";

@Module({})
export class StingerloomOrmCoreModule {
  static forRoot(options: DatabaseClientOptions): DynamicModule {
    return {
      module: StingerloomOrmCoreModule,
      providers: [
        {
          provide: EntityManager,
          useFactory: async () => {
            const em = new EntityManager();
            await em.register(options);
            return em;
          },
        },
      ],
      exports: [EntityManager],
    };
  }
}
