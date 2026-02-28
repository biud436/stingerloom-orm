import { Module } from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";

@Module({})
export class StingerloomOrmCoreModule {
  static forRoot() {
    return {
      module: StingerloomOrmCoreModule,
      providers: [EntityManager],
      exports: [EntityManager],
    };
  }
}
