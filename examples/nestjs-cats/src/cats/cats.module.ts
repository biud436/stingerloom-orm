import { Module } from "@nestjs/common";
import { CatsService } from "./cats.service";
import { CatsController } from "./cats.controller";
import { StinglerloomOrmModule } from "src/stingerloom-orm/stingerloom-orm.module";
import { Cat } from "./cat.entity";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Cat])],
  controllers: [CatsController],
  providers: [CatsService],
})
export class CatsModule {}
