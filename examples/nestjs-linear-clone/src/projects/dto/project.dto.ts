import { ApiProperty } from "@nestjs/swagger";
import {
  IsInt,
  IsString,
  IsOptional,
  Matches,
  MaxLength,
  MinLength,
  IsObject,
} from "class-validator";

export class CreateProjectDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  workspaceId!: number;

  @ApiProperty({ example: "Engineering" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: "ENG", description: "3-6 uppercase letters used as the issue prefix" })
  @IsString()
  @Matches(/^[A-Z][A-Z0-9]{1,5}$/)
  key!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    required: false,
    description: "Custom field schema declared by the project (e.g. severity enum)",
    example: {
      fields: [
        { key: "severity", type: "enum", options: ["S0", "S1", "S2", "S3"] },
      ],
    },
  })
  @IsOptional()
  @IsObject()
  customFieldSchema?: Record<string, unknown>;
}

export class UpdateProjectDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  customFieldSchema?: Record<string, unknown>;
}
