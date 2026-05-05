import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  HttpCode,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { LinksService } from "./links.service";
import { CreateLinkDto } from "./dto/link.dto";
import { CurrentUserId } from "../../common/auth/current-user.decorator";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

@ApiTags("Issue Links")
@ApiBearerAuth()
@Controller("issues")
export class LinksController {
  constructor(private readonly service: LinksService) {}

  @Post(":id/links")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({
    summary:
      "Create a typed link from this issue. `blocks`/`blockedBy` build a DAG; cycles are rejected with 422 CYCLE_DETECTED.",
  })
  create(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CreateLinkDto,
    @CurrentUserId() userId: number,
  ) {
    return this.service.create(id, dto, userId);
  }

  @Delete(":id/links/:linkId")
  @WorkspaceScoped({ from: "issue" })
  @HttpCode(204)
  remove(
    @Param("id", ParseIntPipe) id: number,
    @Param("linkId", ParseIntPipe) linkId: number,
  ) {
    return this.service.remove(id, linkId);
  }

  @Get(":id/dependents")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({
    summary:
      "Transitive closure of issues this issue blocks, ordered by BFS depth.",
  })
  dependents(@Param("id", ParseIntPipe) id: number) {
    return this.service.dependents(id);
  }

  @Get(":id/blockers")
  @WorkspaceScoped({ from: "issue" })
  @ApiOperation({
    summary:
      "Transitive closure of issues that block this issue, ordered by BFS depth.",
  })
  blockers(@Param("id", ParseIntPipe) id: number) {
    return this.service.blockers(id);
  }
}
