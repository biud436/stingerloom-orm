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
import { ProjectsService } from "./projects.service";
import { CreateProjectDto, UpdateProjectDto } from "./dto/project.dto";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";
import { CursorQueryDto } from "../../common/dto/cursor.dto";

@ApiTags("Projects")
@ApiBearerAuth()
@Controller("projects")
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  @Post()
  @WorkspaceScoped({ from: "param", name: "workspaceId" })
  create(@Body() dto: CreateProjectDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({
    summary:
      "List projects (capped at 50; optionally filtered by workspaceId). Use /projects/cursor for full pagination.",
  })
  list(
    @Query("workspaceId") workspaceId?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.findAll(
      workspaceId ? Number(workspaceId) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Get("cursor")
  @ApiOperation({ summary: "Cursor-paginated project list" })
  cursor(
    @Query() q: CursorQueryDto,
    @Query("workspaceId") workspaceId?: string,
  ) {
    return this.service.findWithCursor(
      workspaceId ? Number(workspaceId) : undefined,
      q.take ?? 20,
      q.cursor,
    );
  }

  @Get(":id")
  @WorkspaceScoped({ from: "project" })
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch(":id")
  @WorkspaceScoped({ from: "project" })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateProjectDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  @WorkspaceScoped({ from: "project" })
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
