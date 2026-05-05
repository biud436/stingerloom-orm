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
  Headers,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { IssuesService } from "./issues.service";
import {
  CreateIssueDto,
  UpdateIssueDto,
  AssignLabelDto,
  AssignAssigneeDto,
} from "./dto/issue.dto";

@ApiTags("Issues")
@Controller("issues")
export class IssuesController {
  constructor(private readonly service: IssuesService) {}

  @Post()
  @ApiOperation({ summary: "Create issue (auto-assigns per-project number)" })
  create(@Body() dto: CreateIssueDto) {
    return this.service.create(dto);
  }

  @Get()
  list(@Query("projectId") projectId?: string) {
    return this.service.findAll(projectId ? Number(projectId) : undefined);
  }

  @Get("cursor")
  @ApiOperation({ summary: "Cursor-paginated issue feed" })
  cursor(
    @Query("take") take?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.service.findWithCursor(take ? Number(take) : 20, cursor);
  }

  @Get(":id")
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Get(":id/children")
  @ApiOperation({ summary: "Direct subissues" })
  children(@Param("id", ParseIntPipe) id: number) {
    return this.service.childrenOf(id);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update issue with optimistic locking; returns 409 on stale version",
  })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateIssueDto,
    @Headers("x-actor-user-id") actor?: string,
  ) {
    return this.service.update(id, dto, actor ? Number(actor) : undefined);
  }

  @Patch(":id/assignee")
  @ApiOperation({ summary: "Set or clear the assignee" })
  assign(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: AssignAssigneeDto,
    @Headers("x-actor-user-id") actor?: string,
  ) {
    return this.service.assign(id, dto, actor ? Number(actor) : undefined);
  }

  @Post(":id/labels")
  addLabel(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: AssignLabelDto,
    @Headers("x-actor-user-id") actor?: string,
  ) {
    return this.service.addLabel(id, dto, actor ? Number(actor) : undefined);
  }

  @Delete(":id/labels/:labelId")
  @HttpCode(204)
  removeLabel(
    @Param("id", ParseIntPipe) id: number,
    @Param("labelId", ParseIntPipe) labelId: number,
    @Headers("x-actor-user-id") actor?: string,
  ) {
    return this.service.removeLabel(id, labelId, actor ? Number(actor) : undefined);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.softRemove(id);
  }

  @Post(":id/restore")
  @HttpCode(204)
  restore(@Param("id", ParseIntPipe) id: number) {
    return this.service.restore(id);
  }
}
