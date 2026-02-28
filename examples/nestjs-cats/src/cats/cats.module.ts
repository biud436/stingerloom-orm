import { Module, OnModuleInit } from "@nestjs/common";
import { CatsService } from "./cats.service";
import { CatsController } from "./cats.controller";
import { StinglerloomOrmModule } from "src/stingerloom-orm/stingerloom-orm.module";
import { StinglerloomOrmService } from "src/stingerloom-orm/stingerloom-orm.service";
import { Cat } from "./cat.entity";
import { CatSubscriber } from "./cat.subscriber";
import { OwnersModule } from "src/owners/owners.module";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Cat]), OwnersModule],
  controllers: [CatsController],
  providers: [CatsService],
})
export class CatsModule implements OnModuleInit {
  constructor(private readonly ormService: StinglerloomOrmService) {}

  onModuleInit() {
    const em = this.ormService.getEntityManager();
    em.addSubscriber(new CatSubscriber());
  }
}
