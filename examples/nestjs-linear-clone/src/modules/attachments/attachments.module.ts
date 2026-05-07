import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Attachment } from "./attachment.entity";
import { Issue } from "../issues/issue.entity";
import { Comment } from "../comments/comment.entity";
import { AttachmentsService } from "./attachments.service";
import { AttachmentsController } from "./attachments.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([Attachment, Issue, Comment])],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
