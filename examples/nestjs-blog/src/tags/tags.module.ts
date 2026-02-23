import { Module } from "@nestjs/common";
import { TagsService } from "./tags.service";
import { TagsController } from "./tags.controller";
import { StinglerloomOrmModule } from "src/stingerloom-orm/stingerloom-orm.module";
import { Tag } from "./tag.entity";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Tag])],
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
