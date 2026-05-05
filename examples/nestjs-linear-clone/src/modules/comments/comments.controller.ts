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
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CommentsService } from "./comments.service";
import { CreateCommentDto, UpdateCommentDto } from "./dto/comment.dto";
import { CurrentUserId } from "../../common/auth/current-user.decorator";

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
  byIssue(@Query("issueId", ParseIntPipe) issueId: number) {
    return this.service.findByIssue(issueId);
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
