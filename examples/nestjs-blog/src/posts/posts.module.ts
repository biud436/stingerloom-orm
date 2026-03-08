import { Module } from "@nestjs/common";
import { PostsService } from "./posts.service";
import { PostsController } from "./posts.controller";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Post } from "./post.entity";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Post])],
  controllers: [PostsController],
  providers: [PostsService],
  exports: [PostsService],
})
export class PostsModule {}
