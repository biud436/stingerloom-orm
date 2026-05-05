import { ApiProperty } from "@nestjs/swagger";
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ArrayUnique,
  MaxLength,
} from "class-validator";
import {
  ISSUE_STATUSES,
  IssueStatus,
  MEMBERSHIP_ROLE,
  MembershipRole,
} from "../../../common/enums";

const ROLE_VALUES = Object.values(MEMBERSHIP_ROLE);

export class CreateTransitionDto {
  @ApiProperty({ enum: ISSUE_STATUSES })
  @IsString()
  @IsIn(ISSUE_STATUSES)
  fromState!: IssueStatus;

  @ApiProperty({ enum: ISSUE_STATUSES })
  @IsString()
  @IsIn(ISSUE_STATUSES)
  toState!: IssueStatus;

  @ApiProperty({ required: false, enum: ROLE_VALUES, nullable: true })
  @IsOptional()
  @IsIn(ROLE_VALUES)
  requiredRole?: MembershipRole | null;

  @ApiProperty({ required: false, type: [String], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  requiredFields?: string[] | null;
}
