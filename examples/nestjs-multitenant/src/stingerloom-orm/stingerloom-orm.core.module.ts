import { DynamicModule, Module } from "@nestjs/common";
import { EntityManager, type DatabaseClientOptions } from "@stingerloom/orm";

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
