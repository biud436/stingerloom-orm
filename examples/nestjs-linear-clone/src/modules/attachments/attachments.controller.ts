import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  HttpCode,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { AttachmentsService } from "./attachments.service";
import { CreateAttachmentDto } from "./dto/attachment.dto";
import { ATTACHMENT_OWNER } from "./attachment.entity";
import { CurrentUserId } from "../../common/auth/current-user.decorator";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

@ApiTags("Attachments")
@ApiBearerAuth()
@Controller()
export class AttachmentsController {
  constructor(private readonly service: AttachmentsService) {}

  // ── Issue-owned attachments ─────────────────────

  @Post("issues/:id/attachments")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({ summary: "Attach a file to an issue" })
  attachToIssue(
    @Param("id", ParseIntPipe) issueId: number,
    @CurrentUserId() userId: number,
    @Body() dto: CreateAttachmentDto,
  ) {
    return this.service.create(ATTACHMENT_OWNER.ISSUE, issueId, userId, dto);
  }

  @Get("issues/:id/attachments")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({ summary: "List attachments on an issue" })
  listIssueAttachments(@Param("id", ParseIntPipe) issueId: number) {
    return this.service.listByOwner(ATTACHMENT_OWNER.ISSUE, issueId);
  }

  // ── Comment-owned attachments ───────────────────

  @Post("comments/:id/attachments")
  @WorkspaceScoped({ from: "comment" })
  @ApiOperation({ summary: "Attach a file to a comment" })
  attachToComment(
    @Param("id", ParseIntPipe) commentId: number,
    @CurrentUserId() userId: number,
    @Body() dto: CreateAttachmentDto,
  ) {
    return this.service.create(
      ATTACHMENT_OWNER.COMMENT,
      commentId,
      userId,
      dto,
    );
  }

  @Get("comments/:id/attachments")
  @WorkspaceScoped({ from: "comment" })
  @ApiOperation({ summary: "List attachments on a comment" })
  listCommentAttachments(@Param("id", ParseIntPipe) commentId: number) {
    return this.service.listByOwner(ATTACHMENT_OWNER.COMMENT, commentId);
  }

  // ── Generic attachment ops ──────────────────────

  @Get("attachments/:id")
  @WorkspaceScoped({ from: "attachment" })
  @ApiOperation({ summary: "Get a single attachment" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Delete("attachments/:id")
  @WorkspaceScoped({ from: "attachment" })
  @HttpCode(204)
  @ApiOperation({ summary: "Delete an attachment" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
