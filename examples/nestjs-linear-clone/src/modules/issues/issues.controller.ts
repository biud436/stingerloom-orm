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
import { IssuesService } from "./issues.service";
import {
  CreateIssueDto,
  UpdateIssueDto,
  AssignLabelDto,
  AssignAssigneeDto,
} from "./dto/issue.dto";
import { CurrentUserId } from "../../common/auth/current-user.decorator";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

@ApiTags("Issues")
@ApiBearerAuth()
@Controller("issues")
export class IssuesController {
  constructor(private readonly service: IssuesService) {}

  @Post()
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({ summary: "Create issue (auto-assigns per-project number)" })
  create(@Body() dto: CreateIssueDto, @CurrentUserId() userId: number) {
    return this.service.create(dto, userId);
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
  @WorkspaceScoped({ from: "issue" })
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Get(":id/children")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({ summary: "Direct subissues" })
  children(@Param("id", ParseIntPipe) id: number) {
    return this.service.childrenOf(id);
  }

  @Patch(":id")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({
    summary: "Update issue with optimistic locking; returns 409 on stale version",
  })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateIssueDto,
    @CurrentUserId() userId: number,
  ) {
    return this.service.update(id, dto, userId);
  }

  @Patch(":id/assignee")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({ summary: "Set or clear the assignee" })
  assign(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: AssignAssigneeDto,
    @CurrentUserId() userId: number,
  ) {
    return this.service.assign(id, dto, userId);
  }

  @Post(":id/labels")
  @WorkspaceScoped({ from: "issue" })
  addLabel(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: AssignLabelDto,
    @CurrentUserId() userId: number,
  ) {
    return this.service.addLabel(id, dto, userId);
  }

  @Delete(":id/labels/:labelId")
  @WorkspaceScoped({ from: "issue" })
  @HttpCode(204)
  removeLabel(
    @Param("id", ParseIntPipe) id: number,
    @Param("labelId", ParseIntPipe) labelId: number,
    @CurrentUserId() userId: number,
  ) {
    return this.service.removeLabel(id, labelId, userId);
  }

  @Delete(":id")
  @WorkspaceScoped({ from: "issue" })
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.softRemove(id);
  }

  @Post(":id/restore")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({
    summary:
      "Restore a soft-deleted issue. Pass `?cascade=1` to also restore the soft-deleted descendant subtree.",
  })
  restore(
    @Param("id", ParseIntPipe) id: number,
    @Query("cascade") cascade?: string,
  ) {
    const wantCascade = cascade === "1" || cascade === "true";
    return this.service.restoreWithCascade(id, wantCascade);
  }
}
