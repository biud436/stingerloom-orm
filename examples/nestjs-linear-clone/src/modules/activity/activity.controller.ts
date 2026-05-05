import { Controller, Get, Param, ParseIntPipe, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { ActivityService } from "./activity.service";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

@ApiTags("Activity")
@ApiBearerAuth()
@Controller("activity")
export class ActivityController {
  constructor(private readonly service: ActivityService) {}

  @Get("issues/:id")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({ summary: "Recent activity for an issue (newest first)" })
  byIssue(
    @Param("id", ParseIntPipe) id: number,
    @Query("limit") limit?: string,
  ) {
    return this.service.forIssue(id, limit ? Number(limit) : 50);
  }

  @Get("workspaces/:id")
  @WorkspaceScoped({ from: "param", name: "id" })
  @ApiOperation({ summary: "Recent activity for a workspace" })
  byWorkspace(
    @Param("id", ParseIntPipe) id: number,
    @Query("limit") limit?: string,
  ) {
    return this.service.forWorkspace(id, limit ? Number(limit) : 100);
  }
}
