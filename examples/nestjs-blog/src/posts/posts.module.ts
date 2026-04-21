import { Module } from "@nestjs/common";
import { PostsService } from "./posts.service";
import { PostsController } from "./posts.controller";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Post } from "./post.entity";

@Module({
  imports: [StingerloomOrmModule.forFeature([Post])],
  controllers: [PostsController],
  providers: [PostsService],
  exports: [PostsService],
})
export class PostsModule {}
