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
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { MembershipsService } from "./memberships.service";
import { CreateMembershipDto, UpdateMembershipRoleDto } from "./dto/membership.dto";

@ApiTags("Memberships")
@Controller("memberships")
export class MembershipsController {
  constructor(private readonly service: MembershipsService) {}

  @Post()
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
  @ApiOperation({ summary: "Change a member's role" })
  changeRole(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateMembershipRoleDto,
  ) {
    return this.service.updateRole(id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Revoke membership" })
  revoke(@Param("id", ParseIntPipe) id: number) {
    return this.service.revoke(id);
  }
}
