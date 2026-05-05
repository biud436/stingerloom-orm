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
  ForbiddenException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { qAlias, EntityManager } from "@stingerloom/orm";
import { Inject } from "@nestjs/common";
import { WorkspacesService } from "./workspaces.service";
import { CreateWorkspaceDto, UpdateWorkspaceDto } from "./dto/workspace.dto";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";
import { CurrentUserId } from "../../common/auth/current-user.decorator";
import { Membership } from "../memberships/membership.entity";

@ApiTags("Workspaces")
@ApiBearerAuth()
@Controller("workspaces")
export class WorkspacesController {
  constructor(
    private readonly service: WorkspacesService,
    @Inject(EntityManager) private readonly em: EntityManager,
  ) {}

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
    const m = qAlias(Membership, "m");
    const rows = await this.em
      .createQueryBuilder(m)
      .leftJoinRelationAndSelect("workspace", "w")
      .where(m.userId.eq(userId))
      .getMany();
    return rows.map((r) => r.workspace);
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
    const m = qAlias(Membership, "m");
    const owner = await this.em
      .createQueryBuilder(m)
      .where(m.workspaceId.eq(id))
      .andWhere(m.userId.eq(userId))
      .andWhere(m.role.eq("OWNER"))
      .limit(1)
      .getOne();
    if (!owner) {
      throw new ForbiddenException("Only OWNER can delete the workspace");
    }
    return this.service.remove(id);
  }
}
