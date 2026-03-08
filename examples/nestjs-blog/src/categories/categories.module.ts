import { Module } from "@nestjs/common";
import { CategoriesService } from "./categories.service";
import { CategoriesController } from "./categories.controller";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Category } from "./category.entity";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Category])],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
