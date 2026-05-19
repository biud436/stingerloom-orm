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
  Inject,
  forwardRef,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { ProjectsService } from "./projects.service";
import { CreateProjectDto, UpdateProjectDto } from "./dto/project.dto";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";
import { CursorQueryDto } from "../../common/dto/cursor.dto";
import { IssuesService } from "../issues/issues.service";

@ApiTags("Projects")
@ApiBearerAuth()
@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly service: ProjectsService,
    @Inject(forwardRef(() => IssuesService))
    private readonly issues: IssuesService,
  ) {}

  @Post()
  @WorkspaceScoped({ from: "param", name: "workspaceId" })
  create(@Body() dto: CreateProjectDto) {
    return this.service.create(dto);
  }

  @Get()
  @WorkspaceScoped({ from: "param", name: "workspaceId" })
  @ApiOperation({
    summary:
      "List projects in a workspace (capped at 50). workspaceId is required — membership is enforced. Use /projects/cursor for full pagination.",
  })
  list(
    @Query("workspaceId") workspaceId: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.findAll(
      Number(workspaceId),
      limit ? Number(limit) : undefined,
    );
  }

  @Get("cursor")
  @WorkspaceScoped({ from: "param", name: "workspaceId" })
  @ApiOperation({ summary: "Cursor-paginated project list (workspaceId required)" })
  cursor(
    @Query() q: CursorQueryDto,
    @Query("workspaceId") workspaceId: string,
  ) {
    return this.service.findWithCursor(
      Number(workspaceId),
      q.take ?? 20,
      q.cursor,
    );
  }

  @Get(":id")
  @WorkspaceScoped({ from: "project" })
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Get(":id/trash")
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({
    summary:
      "Soft-deleted issues for this project (newest deletion first). " +
      "Bypasses the auto deletedAt IS NULL filter via QueryBuilder.withDeleted().",
  })
  trash(
    @Param("id", ParseIntPipe) id: number,
    @Query("limit") limit?: string,
  ) {
    return this.issues.findTrash(id, limit ? Number(limit) : undefined);
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
