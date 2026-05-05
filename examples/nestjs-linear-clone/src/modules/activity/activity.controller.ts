import { Controller, Get, Param, ParseIntPipe, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { ActivityService } from "./activity.service";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";
import { CursorQueryDto } from "../../common/dto/cursor.dto";

@ApiTags("Activity")
@ApiBearerAuth()
@Controller("activity")
export class ActivityController {
  constructor(private readonly service: ActivityService) {}

  @Get("issues/:id")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({
    summary:
      "Recent activity for an issue (newest first; capped at limit). Use /activity/issues/:id/cursor for pagination.",
  })
  byIssue(
    @Param("id", ParseIntPipe) id: number,
    @Query("limit") limit?: string,
  ) {
    return this.service.forIssue(id, limit ? Number(limit) : 50);
  }

  @Get("issues/:id/cursor")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({ summary: "Cursor-paginated issue activity feed (DESC by id)" })
  byIssueCursor(
    @Param("id", ParseIntPipe) id: number,
    @Query() q: CursorQueryDto,
  ) {
    return this.service.forIssueCursor(id, q.take ?? 20, q.cursor);
  }

  @Get("workspaces/:id")
  @WorkspaceScoped({ from: "param", name: "id" })
  @ApiOperation({
    summary:
      "Recent activity for a workspace (capped at limit). Use /activity/workspaces/:id/cursor for pagination.",
  })
  byWorkspace(
    @Param("id", ParseIntPipe) id: number,
    @Query("limit") limit?: string,
  ) {
    return this.service.forWorkspace(id, limit ? Number(limit) : 100);
  }

  @Get("workspaces/:id/cursor")
  @WorkspaceScoped({ from: "param", name: "id" })
  @ApiOperation({ summary: "Cursor-paginated workspace activity feed (DESC by id)" })
  byWorkspaceCursor(
    @Param("id", ParseIntPipe) id: number,
    @Query() q: CursorQueryDto,
  ) {
    return this.service.forWorkspaceCursor(id, q.take ?? 20, q.cursor);
  }
}
