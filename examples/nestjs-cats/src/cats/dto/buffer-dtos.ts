import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { CreateCatDto } from "./create-cat.dto";
import { UpdateCatDto } from "./update-cat.dto";

// ── Batch Update ────────────────────────────────────────────────

export class BufferBatchUpdateItemDto {
  @ApiProperty({ description: "Cat ID to update", example: 1 })
  @IsInt()
  @Min(1)
  id!: number;

  @ApiPropertyOptional({ example: "Mittens" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  age?: number;

  @ApiPropertyOptional({ example: "Siamese" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  breed?: string;
}

export class BufferBatchUpdateDto {
  @ApiProperty({ type: [BufferBatchUpdateItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BufferBatchUpdateItemDto)
  updates!: BufferBatchUpdateItemDto[];
}

// ── Mixed Flush ─────────────────────────────────────────────────

export class BufferMixedFlushDto {
  @ApiProperty({ type: CreateCatDto })
  @ValidateNested()
  @Type(() => CreateCatDto)
  create!: CreateCatDto;

  @ApiProperty({ description: "ID of cat to update", example: 1 })
  @IsInt()
  @Min(1)
  updateId!: number;

  @ApiProperty({ type: UpdateCatDto })
  @ValidateNested()
  @Type(() => UpdateCatDto)
  update!: UpdateCatDto;

  @ApiProperty({ description: "ID of cat to delete", example: 2 })
  @IsInt()
  @Min(1)
  deleteId!: number;
}

// ── Preview ─────────────────────────────────────────────────────

export class BufferPreviewDto {
  @ApiProperty({ type: [Number], description: "Cat IDs to mutate" })
  @IsArray()
  @IsInt({ each: true })
  ids!: number[];

  @ApiPropertyOptional({ example: "Previewed" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  age?: number;

  @ApiPropertyOptional({ example: "Ragdoll" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  breed?: string;
}

// ── With Owner ──────────────────────────────────────────────────

export class BufferOwnerDataDto {
  @ApiProperty({ example: "Bob" })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: "bob@test.com" })
  @IsString()
  @IsNotEmpty()
  email!: string;
}

export class BufferWithOwnerDto {
  @ApiProperty({ type: BufferOwnerDataDto })
  @ValidateNested()
  @Type(() => BufferOwnerDataDto)
  owner!: BufferOwnerDataDto;

  @ApiProperty({ type: CreateCatDto })
  @ValidateNested()
  @Type(() => CreateCatDto)
  cat!: CreateCatDto;
}
