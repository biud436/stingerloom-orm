import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Comment } from "./comment.entity";
import { CommentsService } from "./comments.service";
import { CommentsController } from "./comments.controller";
import { ActivityModule } from "../activity/activity.module";

@Module({
  imports: [StingerloomOrmModule.forFeature([Comment]), ActivityModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
