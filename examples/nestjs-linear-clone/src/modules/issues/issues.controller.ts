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
  Req,
  BadRequestException,
} from "@nestjs/common";
import { Request } from "express";
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
import { assertIfMatch } from "../../common/concurrency/etag.interceptor";

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
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({
    summary:
      "List issues for a project. `projectId` is required and membership-checked " +
      "(the guard rejects a foreign project with 403); results are capped (default 100, max 500).",
  })
  list(
    @Query("projectId", ParseIntPipe) projectId: number,
    @Query("limit") limit?: string,
  ) {
    return this.service.findAll(projectId, limit ? Number(limit) : undefined);
  }

  @Get("cursor")
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({
    summary:
      "Cursor-paginated issue feed for a project. `projectId` is required and " +
      "membership-checked so the cursor walk cannot enumerate other tenants.",
  })
  cursor(
    @Query("projectId", ParseIntPipe) projectId: number,
    @Query("take") take?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.service.findWithCursor(
      projectId,
      take ? Number(take) : 20,
      cursor,
    );
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
    summary:
      "Update issue with optimistic locking. Anchor the expected version via " +
      "either body.expectedVersion or `If-Match: W/\"<n>\"` header. " +
      "Stale → 412 (If-Match path) or 409 (body path); current ETag is on " +
      "the GET response.",
  })
  async update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateIssueDto,
    @CurrentUserId() userId: number,
    @Req() req: Request,
  ) {
    // If the caller supplied If-Match, fetch the current row, validate the
    // header against its version (raises 412 on stale), and use the parsed
    // version as the lock anchor. Body-supplied expectedVersion remains the
    // fallback so REST and the legacy body-driven path coexist.
    const ifMatchHeader = req.header("if-match");
    if (ifMatchHeader) {
      const current = await this.service.findOne(id);
      const v = assertIfMatch(req, current.version);
      // assertIfMatch returned non-null because the header was present.
      dto.expectedVersion = v ?? current.version;
    } else if (dto.expectedVersion === undefined) {
      throw new BadRequestException(
        "expectedVersion is required when no If-Match header is supplied",
      );
    }
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
  remove(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUserId() userId: number,
  ) {
    return this.service.softRemove(id, userId);
  }

  @Post(":id/restore")
  @WorkspaceScoped({ from: "issue" })
  @HttpCode(204)
  @ApiOperation({
    summary:
      "Restore a soft-deleted issue. Pass `?cascade=1` to also restore the soft-deleted descendant subtree.",
  })
  async restore(
    @Param("id", ParseIntPipe) id: number,
    @CurrentUserId() userId: number,
    @Query("cascade") cascade?: string,
  ): Promise<void> {
    const wantCascade = cascade === "1" || cascade === "true";
    await this.service.restoreWithCascade(id, wantCascade, userId);
  }
}
