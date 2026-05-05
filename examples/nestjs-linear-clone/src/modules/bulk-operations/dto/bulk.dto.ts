import {
  IsArray,
  IsInt,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsOptional,
  IsObject,
  IsString,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class BulkUpdateIssuesDto {
  @ApiProperty({ description: "Issue ids to patch (1-200)", type: [Number] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  ids!: number[];

  @ApiProperty({
    description:
      "Per-row optimistic-lock anchors aligned with `ids` index-by-index. Length must match.",
    type: [Number],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  expectedVersions!: number[];

  @ApiProperty({
    description: "Patch applied to every row that loads cleanly",
    example: { status: "DONE", sprintId: 12 },
  })
  @IsObject()
  patch!: Record<string, unknown>;
}

export class BulkRowResultDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: ["ok", "conflict", "not_found", "error"] })
  status!: "ok" | "conflict" | "not_found" | "error";
  @ApiPropertyOptional() version?: number;
  @ApiPropertyOptional() error?: string;
}

export class BulkUpdateResponseDto {
  @ApiProperty() bulkOperationId!: number;
  @ApiProperty({ type: [BulkRowResultDto] })
  results!: BulkRowResultDto[];
  @ApiProperty()
  summary!: {
    total: number;
    ok: number;
    conflict: number;
    notFound: number;
    error: number;
  };
}
