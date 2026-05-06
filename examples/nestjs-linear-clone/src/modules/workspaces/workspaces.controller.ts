import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  HttpCode,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { WorkspacesService } from "./workspaces.service";
import { CreateWorkspaceDto, UpdateWorkspaceDto } from "./dto/workspace.dto";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";
import { CurrentUserId } from "../../common/auth/current-user.decorator";

@ApiTags("Workspaces")
@ApiBearerAuth()
@Controller("workspaces")
export class WorkspacesController {
  constructor(private readonly service: WorkspacesService) {}

  /**
   * Anyone authenticated can create a workspace; the creator is auto-enrolled
   * as the OWNER member so subsequent calls can pass `WorkspaceMemberGuard`.
   */
  @Post()
  @ApiOperation({ summary: "Create a workspace + enroll caller as OWNER" })
  async create(@Body() dto: CreateWorkspaceDto, @CurrentUserId() userId: number) {
    return this.service.createWithOwner(dto, userId);
  }

  /**
   * Lists every workspace the caller is a member of. Cross-tenant isolation
   * is enforced at the SQL level, not by trusting a query param.
   */
  @Get()
  @ApiOperation({ summary: "List workspaces the caller is a member of" })
  async list(@CurrentUserId() userId: number) {
    return this.service.listForUser(userId);
  }

  @Get(":id")
  @WorkspaceScoped({ from: "param", name: "id" })
  @ApiOperation({ summary: "Get workspace by id" })
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch(":id")
  @WorkspaceScoped({ from: "param", name: "id" })
  @ApiOperation({ summary: "Update workspace" })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateWorkspaceDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  @WorkspaceScoped({ from: "param", name: "id" })
  @HttpCode(204)
  @ApiOperation({ summary: "Delete workspace (OWNER-only — enforced server-side)" })
  async remove(@Param("id", ParseIntPipe) id: number, @CurrentUserId() userId: number) {
    return this.service.removeAsOwner(id, userId);
  }
}
