import { ApiProperty } from "@nestjs/swagger";
import {
  IsInt,
  IsString,
  IsOptional,
  IsIn,
  IsObject,
  Min,
  Max,
  MinLength,
  MaxLength,
} from "class-validator";
import {
  ISSUE_STATUS,
  ISSUE_PRIORITY,
  IssueStatus,
  IssuePriority,
} from "../../../common/enums";

export class CreateIssueDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  projectId!: number;

  @ApiProperty({ example: "Login button stays disabled after a failed signup" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  description?: string;

  @ApiProperty({ required: false, enum: Object.values(ISSUE_STATUS) })
  @IsOptional()
  @IsIn(Object.values(ISSUE_STATUS))
  status?: IssueStatus;

  @ApiProperty({
    required: false,
    enum: Object.values(ISSUE_PRIORITY),
    example: ISSUE_PRIORITY.HIGH,
  })
  @IsOptional()
  @IsInt()
  @IsIn(Object.values(ISSUE_PRIORITY))
  priority?: IssuePriority;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  estimate?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  sprintId?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  assigneeId?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  parentId?: number;

  @ApiProperty({ required: false, description: "JSON shaped per project's customFieldSchema" })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateIssueDto {
  /**
   * Optimistic-lock anchor. Either pass it here or send an
   * `If-Match: W/"<version>"` request header — the header wins when both
   * are present so REST-native concurrency works without changing the
   * body shape.
   */
  @ApiProperty({
    description:
      "Current version (optimistic lock). Optional when the request carries an If-Match header.",
    example: 3,
    required: false,
  })
  @IsOptional()
  @IsInt()
  expectedVersion?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, enum: Object.values(ISSUE_STATUS) })
  @IsOptional()
  @IsIn(Object.values(ISSUE_STATUS))
  status?: IssueStatus;

  @ApiProperty({ required: false, enum: Object.values(ISSUE_PRIORITY) })
  @IsOptional()
  @IsInt()
  @IsIn(Object.values(ISSUE_PRIORITY))
  priority?: IssuePriority;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  estimate?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  sprintId?: number;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  assigneeId?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class AssignLabelDto {
  @ApiProperty()
  @IsInt()
  labelId!: number;
}

export class AssignAssigneeDto {
  @ApiProperty({ nullable: true, description: "userId, or null to unassign" })
  @IsOptional()
  assigneeId!: number | null;
}
