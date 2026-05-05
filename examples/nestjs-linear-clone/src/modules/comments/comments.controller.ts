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
import { ApiTags } from "@nestjs/swagger";
import { CommentsService } from "./comments.service";
import { CreateCommentDto, UpdateCommentDto } from "./dto/comment.dto";

@ApiTags("Comments")
@Controller("comments")
export class CommentsController {
  constructor(private readonly service: CommentsService) {}

  @Post()
  create(@Body() dto: CreateCommentDto) {
    return this.service.create(dto);
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
