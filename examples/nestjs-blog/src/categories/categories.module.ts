import { Module } from "@nestjs/common";
import { CategoriesService } from "./categories.service";
import { CategoriesController } from "./categories.controller";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Category } from "./category.entity";

@Module({
  imports: [StingerloomOrmModule.forFeature([Category])],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
