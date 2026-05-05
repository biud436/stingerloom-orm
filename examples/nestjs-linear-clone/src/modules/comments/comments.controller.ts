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
import { CreateCommentDto, UpdateCommentDto } from "./dto/comment.dto";
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

  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateCommentDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.softRemove(id);
  }
}
