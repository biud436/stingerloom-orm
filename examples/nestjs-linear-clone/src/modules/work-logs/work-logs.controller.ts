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
import { WorkLogsService } from "./work-logs.service";
import { CreateWorkLogDto, UpdateWorkLogDto } from "./dto/work-log.dto";
import { CurrentUserId } from "../../common/auth/current-user.decorator";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

/**
 * Time-tracking endpoints. Two route prefixes share the service:
 *   /issues/:id/work-logs        — issue-scoped CRUD
 *   /work-logs/...               — flat updates / per-user dashboards
 *   /analytics/projects/:id/velocity — sprint velocity rolling window
 *
 * Velocity is colocated under /analytics in the controller layer so the
 * Swagger group lines up with the rest of the analytics endpoints.
 */
@ApiTags("WorkLogs")
@ApiBearerAuth()
@Controller()
export class WorkLogsController {
  constructor(private readonly service: WorkLogsService) {}

  @Post("issues/:id/work-logs")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({ summary: "Log time against an issue" })
  create(
    @Param("id", ParseIntPipe) issueId: number,
    @CurrentUserId() userId: number,
    @Body() dto: CreateWorkLogDto,
  ) {
    return this.service.create(issueId, userId, dto);
  }

  @Get("issues/:id/work-logs")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({ summary: "Per-issue work log timeline" })
  list(@Param("id", ParseIntPipe) issueId: number) {
    return this.service.findByIssue(issueId);
  }

  @Get("work-logs/:id")
  @ApiOperation({ summary: "Get a single work log entry" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch("work-logs/:id")
  @ApiOperation({ summary: "Update a work log entry" })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateWorkLogDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete("work-logs/:id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a work log entry" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  @Get("users/me/work-logs/daily")
  @ApiOperation({
    summary: "Per-day total hours for the current user",
    description: "GROUP BY DATE(logged_at), portable across MySQL/Postgres via dayOf() helper.",
  })
  myDailyHours(
    @CurrentUserId() userId: number,
    @Query("days") days?: string,
  ) {
    return this.service.dailyHoursByUser(userId, days ? Number(days) : 30);
  }

  @Get("analytics/projects/:id/velocity")
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({
    summary: "Sprint velocity rolling-window average",
    description:
      "AVG(SUM(hours)) OVER (ORDER BY start_date ROWS BETWEEN N PRECEDING AND CURRENT ROW) — N defaults to 3.",
  })
  velocity(
    @Param("id", ParseIntPipe) projectId: number,
    @Query("window") window?: string,
  ) {
    return this.service.sprintVelocity(
      projectId,
      window ? Number(window) : 3,
    );
  }
}
