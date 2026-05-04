import { Controller, Get, Param, ParseIntPipe, Query } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { ActivityService } from "./activity.service";

@ApiTags("Activity")
@Controller("activity")
export class ActivityController {
  constructor(private readonly service: ActivityService) {}

  @Get("issues/:id")
  @ApiOperation({ summary: "Recent activity for an issue (newest first)" })
  byIssue(
    @Param("id", ParseIntPipe) id: number,
    @Query("limit") limit?: string,
  ) {
    return this.service.forIssue(id, limit ? Number(limit) : 50);
  }

  @Get("workspaces/:id")
  @ApiOperation({ summary: "Recent activity for a workspace" })
  byWorkspace(
    @Param("id", ParseIntPipe) id: number,
    @Query("limit") limit?: string,
  ) {
    return this.service.forWorkspace(id, limit ? Number(limit) : 100);
  }
}
