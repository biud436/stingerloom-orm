import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  Query,
  HttpCode,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { CommentsService } from "./comments.service";
import {
  CreateCommentDto,
  UpdateCommentDto,
  AddReactionDto,
} from "./dto/comment.dto";
import { CurrentUserId } from "../../common/auth/current-user.decorator";
import { CursorQueryDto } from "../../common/dto/cursor.dto";

@ApiTags("Comments")
@ApiBearerAuth()
@Controller("comments")
export class CommentsController {
  constructor(private readonly service: CommentsService) {}

  @Post()
  create(
    @Body() dto: CreateCommentDto,
    @CurrentUserId() userId: number,
  ) {
    return this.service.create(dto, userId);
  }

  @Get()
  @ApiOperation({
    summary:
      "Comments for an issue (capped at 100; use /comments/cursor for paginated walk)",
  })
  byIssue(
    @Query("issueId", ParseIntPipe) issueId: number,
    @Query("limit") limit?: string,
  ) {
    return this.service.findByIssue(issueId, limit ? Number(limit) : undefined);
  }

  @Get("cursor")
  @ApiOperation({ summary: "Cursor-paginated comments for an issue (stable ascending by id)" })
  cursor(
    @Query("issueId", ParseIntPipe) issueId: number,
    @Query() q: CursorQueryDto,
  ) {
    return this.service.findByIssueCursor(issueId, q.take ?? 20, q.cursor);
  }

  @Get(":id/thread")
  @ApiOperation({
    summary: "Recursive thread starting from this comment (depth-first by path)",
  })
  thread(@Param("id", ParseIntPipe) id: number) {
    return this.service.thread(id);
  }

  @Get(":id/revisions")
  @ApiOperation({
    summary: "Edit history (oldest first); each row is the body that was replaced",
  })
  revisions(@Param("id", ParseIntPipe) id: number) {
    return this.service.revisions(id);
  }

  @Get(":id/reactions")
  @ApiOperation({
    summary: "Aggregated reactions on this comment, grouped by emoji",
  })
  listReactions(@Param("id", ParseIntPipe) id: number) {
    return this.service.listReactions(id);
  }

  @Post(":id/reactions")
  @ApiOperation({
    summary: "Add a reaction (idempotent — composite PK swallows duplicates)",
  })
  addReaction(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: AddReactionDto,
    @CurrentUserId() userId: number,
  ) {
    return this.service.addReaction(id, dto, userId);
  }

  @Delete(":id/reactions/:emoji")
  @HttpCode(204)
  @ApiOperation({
    summary: "Remove the calling user's reaction with the given emoji",
  })
  async removeReaction(
    @Param("id", ParseIntPipe) id: number,
    @Param("emoji") emoji: string,
    @CurrentUserId() userId: number,
  ): Promise<void> {
    await this.service.removeReaction(id, decodeURIComponent(emoji), userId);
  }

  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateCommentDto,
    @CurrentUserId() userId: number,
  ) {
    return this.service.update(id, dto, userId);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.softRemove(id);
  }
}
