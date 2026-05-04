import { ApiProperty } from "@nestjs/swagger";
import {
  IsInt,
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
} from "class-validator";
import { SPRINT_STATUS, SprintStatus } from "../../common/enums";

export class CreateSprintDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  projectId!: number;

  @ApiProperty({ example: "Sprint 12" })
  @IsString()
  name!: string;

  @ApiProperty({ enum: Object.values(SPRINT_STATUS), example: "PLANNED" })
  @IsIn(Object.values(SPRINT_STATUS))
  status!: SprintStatus;

  @ApiProperty({ required: false, example: "2026-04-15" })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false, example: "2026-04-29" })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class UpdateSprintDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, enum: Object.values(SPRINT_STATUS) })
  @IsOptional()
  @IsIn(Object.values(SPRINT_STATUS))
  status?: SprintStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
