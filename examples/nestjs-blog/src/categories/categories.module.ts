import { Module } from "@nestjs/common";
import { CategoriesService } from "./categories.service";
import { CategoriesController } from "./categories.controller";
import { StinglerloomOrmModule } from "src/stingerloom-orm/stingerloom-orm.module";
import { Category } from "./category.entity";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Category])],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
