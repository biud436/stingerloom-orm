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
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { MembershipsService } from "./memberships.service";
import { CreateMembershipDto, UpdateMembershipRoleDto } from "./dto/membership.dto";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

@ApiTags("Memberships")
@ApiBearerAuth()
@Controller("memberships")
export class MembershipsController {
  constructor(private readonly service: MembershipsService) {}

  @Post()
  @WorkspaceScoped({ from: "param", name: "workspaceId" })
  @ApiOperation({ summary: "Invite a user to a workspace with a role" })
  invite(@Body() dto: CreateMembershipDto) {
    return this.service.invite(dto);
  }

  @Get()
  @ApiOperation({ summary: "List memberships, filterable by workspaceId or userId" })
  list(
    @Query("workspaceId") workspaceId?: string,
    @Query("userId") userId?: string,
  ) {
    if (workspaceId) return this.service.byWorkspace(Number(workspaceId));
    if (userId) return this.service.byUser(Number(userId));
    return [];
  }

  @Patch(":id/role")
  @WorkspaceScoped({ from: "membership" })
  @ApiOperation({
    summary:
      "Change a member's role. Requires the actor to be an ADMIN/OWNER of the " +
      "same workspace; the last OWNER cannot be demoted.",
  })
  changeRole(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateMembershipRoleDto,
  ) {
    return this.service.updateRole(id, dto);
  }

  @Delete(":id")
  @WorkspaceScoped({ from: "membership" })
  @HttpCode(204)
  @ApiOperation({
    summary:
      "Revoke membership. Requires the actor to be an ADMIN/OWNER of the same " +
      "workspace; the last OWNER cannot be revoked.",
  })
  revoke(@Param("id", ParseIntPipe) id: number) {
    return this.service.revoke(id);
  }
}
