import { Module } from "@nestjs/common";
import { TagsService } from "./tags.service";
import { TagsController } from "./tags.controller";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Tag } from "./tag.entity";

@Module({
  imports: [StingerloomOrmModule.forFeature([Tag])],
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
