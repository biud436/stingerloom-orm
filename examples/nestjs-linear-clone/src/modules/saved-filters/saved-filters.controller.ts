import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentUserId } from "../../common/auth/current-user.decorator";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";
import { CreateSavedFilterDto } from "./dto/saved-filter.dto";
import { SavedFiltersService } from "./saved-filters.service";

@ApiTags("Saved Filters")
@ApiBearerAuth()
@Controller("saved-filters")
export class SavedFiltersController {
  constructor(private readonly service: SavedFiltersService) {}

  @Post()
  @WorkspaceScoped({ from: "body", name: "workspaceId" })
  @ApiOperation({
    summary:
      "Create a saved filter. The definition is a JQL-like AST validated " +
      "against the Issue field allowlist before persisting.",
  })
  create(
    @Body() dto: CreateSavedFilterDto,
    @CurrentUserId() userId: number,
  ) {
    return this.service.create(dto, userId);
  }

  @Get()
  @ApiOperation({
    summary:
      "List saved filters across the workspaces the caller is a member of. " +
      "Filters in workspaces the caller does not belong to are never returned.",
  })
  list(@CurrentUserId() userId: number) {
    return this.service.findAll(userId);
  }

  @Get(":id")
  @WorkspaceScoped({ from: "savedFilter" })
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Delete(":id")
  @WorkspaceScoped({ from: "savedFilter" })
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  @Get(":id/run")
  @WorkspaceScoped({ from: "savedFilter" })
  @ApiOperation({
    summary:
      "Run a saved filter against issues. `op: \"me\"` is bound to the " +
      "current authenticated user via RequestContext.",
  })
  run(
    @Param("id", ParseIntPipe) id: number,
    @Query("take") take?: string,
    @Query("cursor") cursor?: string,
  ) {
    const n = take !== undefined ? Number(take) : 20;
    const parsedTake = Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 20;
    return this.service.run(id, parsedTake, cursor);
  }
}
