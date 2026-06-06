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
  ForbiddenException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { MembershipsService } from "./memberships.service";
import { CreateMembershipDto, UpdateMembershipRoleDto } from "./dto/membership.dto";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";
import { CurrentUserId } from "../../common/auth/current-user.decorator";

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
  @ApiOperation({
    summary:
      "List memberships. `?workspaceId=` requires the caller to be a member " +
      "of that workspace; `?userId=` is restricted to the caller's own id. " +
      "With no filter, returns the caller's own memberships.",
  })
  list(
    @CurrentUserId() actorUserId: number,
    @Query("workspaceId") workspaceId?: string,
    @Query("userId") userId?: string,
  ) {
    // byWorkspace() enforces that the actor is a member of `workspaceId`.
    if (workspaceId) return this.service.byWorkspace(Number(workspaceId));
    // The userId filter must not let a caller enumerate another user's
    // workspaces — only their own.
    if (userId) {
      if (Number(userId) !== actorUserId) {
        throw new ForbiddenException(
          "You may only list your own memberships",
        );
      }
      return this.service.byUser(actorUserId);
    }
    return this.service.byUser(actorUserId);
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
