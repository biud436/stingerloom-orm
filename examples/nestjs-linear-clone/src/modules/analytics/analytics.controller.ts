import { Controller, Get, Param, ParseIntPipe, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

@ApiTags("Analytics")
@ApiBearerAuth()
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get("issues/:id/tree")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({
    summary: "Recursive subissue tree",
    description: "Walks parent_id chain via WITH RECURSIVE. Returns one row per descendant ordered by tree path.",
  })
  tree(
    @Param("id", ParseIntPipe) id: number,
    @Query("maxDepth") maxDepth?: string,
  ) {
    return this.service.issueTree(id, maxDepth ? Number(maxDepth) : 10);
  }

  @Get("sprints/:id/burndown")
  @ApiOperation({
    summary: "Sprint burndown by day",
    description: "Window function (SUM OVER ORDER BY day) gives running cumulative completion and remaining estimate.",
  })
  burndown(@Param("id", ParseIntPipe) id: number) {
    return this.service.sprintBurndown(id);
  }

  @Get("projects/:id/throughput")
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({
    summary: "Assignee throughput ranking",
    description: "ROW_NUMBER OVER (ORDER BY completedCount DESC, avgCycleHours ASC) ranks assignees in the project.",
  })
  throughput(
    @Param("id", ParseIntPipe) id: number,
    @Query("days") days?: string,
  ) {
    return this.service.assigneeThroughput(id, days ? Number(days) : 30);
  }

  @Get("issues/:id/time-in-status")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({
    summary: "Time spent in each status",
    description: "LAG/LEAD over activity_log STATUS_CHANGED rows. Reads payload->>'to' for the entered status.",
  })
  timeInStatus(@Param("id", ParseIntPipe) id: number) {
    return this.service.timeInStatus(id);
  }

  @Get("projects/:id/lead-time")
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({ summary: "Average lead time per week" })
  leadTime(
    @Param("id", ParseIntPipe) id: number,
    @Query("days") days?: string,
  ) {
    return this.service.leadTimeByWeek(id, days ? Number(days) : 60);
  }

  @Get("projects/:id/cycle-time-percentiles")
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({
    summary: "Cycle-time percentiles (P50/P75/P95)",
    description:
      "PostgreSQL: percentile_cont WITHIN GROUP. MySQL: ROW_NUMBER+CEIL(N*p) emulation.",
  })
  cycleTimePercentiles(
    @Param("id", ParseIntPipe) id: number,
    @Query("days") days?: string,
  ) {
    return this.service.cycleTimePercentiles(id, days ? Number(days) : 60);
  }
}
