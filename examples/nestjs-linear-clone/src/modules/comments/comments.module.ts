import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Comment } from "./comment.entity";
import { Reaction } from "./reaction.entity";
import { CommentRevision } from "./comment-revision.entity";
import { CommentsService } from "./comments.service";
import { CommentsController } from "./comments.controller";
import { ActivityModule } from "../activity/activity.module";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([Comment, Reaction, CommentRevision]),
    ActivityModule,
  ],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
