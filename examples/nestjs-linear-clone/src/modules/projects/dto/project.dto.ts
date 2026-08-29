import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsInt,
  IsString,
  IsOptional,
  Matches,
  MaxLength,
  MinLength,
  IsObject,
} from "class-validator";
import { CursorQueryDto } from "../../../common/dto/cursor.dto";

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

/**
 * Query contract for `GET /projects/cursor`. Every query key must be declared
 * here: the global ValidationPipe runs with `forbidNonWhitelisted`, so binding
 * `@Query() q: CursorQueryDto` next to a separate `@Query("workspaceId")`
 * 400s the request — the DTO sees the whole query object, and `workspaceId`
 * was outside its whitelist. The membership guard is unaffected either way
 * (it reads the raw `req.query` before pipes run).
 */
export class ProjectCursorQueryDto extends CursorQueryDto {
  @ApiProperty({ example: 1, description: "Workspace to page projects from (membership enforced)" })
  @Type(() => Number)
  @IsInt()
  workspaceId!: number;
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
