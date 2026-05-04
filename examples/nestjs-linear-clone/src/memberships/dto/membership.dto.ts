import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsIn } from "class-validator";
import { MEMBERSHIP_ROLE, MembershipRole } from "../../common/enums";

export class CreateMembershipDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  workspaceId!: number;

  @ApiProperty({ example: 1 })
  @IsInt()
  userId!: number;

  @ApiProperty({ enum: Object.values(MEMBERSHIP_ROLE) })
  @IsIn(Object.values(MEMBERSHIP_ROLE))
  role!: MembershipRole;
}

export class UpdateMembershipRoleDto {
  @ApiProperty({ enum: Object.values(MEMBERSHIP_ROLE) })
  @IsIn(Object.values(MEMBERSHIP_ROLE))
  role!: MembershipRole;
}
