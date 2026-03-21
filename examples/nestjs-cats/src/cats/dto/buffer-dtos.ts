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

// ── Batch Rename ────────────────────────────────────────────────

export class RenameItemDto {
  @ApiProperty({ description: "Cat ID", example: 1 })
  @IsInt()
  @Min(1)
  id!: number;

  @ApiProperty({ description: "New name", example: "Mittens" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}

export class BufferRenameDto {
  @ApiProperty({ type: [RenameItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RenameItemDto)
  updates!: RenameItemDto[];
}

// ── Mixed Flush (create + update + delete) ──────────────────────

class MixedUpdateItemDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  id!: number;

  @ApiPropertyOptional({ example: "Updated" })
  @IsOptional()
  @IsString()
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
  @MaxLength(100)
  breed?: string;
}

export class BufferMixedFlushDto {
  @ApiPropertyOptional({ type: [CreateCatDto], description: "Cats to create" })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateCatDto)
  create?: CreateCatDto[];

  @ApiPropertyOptional({ type: [MixedUpdateItemDto], description: "Cats to update" })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MixedUpdateItemDto)
  update?: MixedUpdateItemDto[];

  @ApiPropertyOptional({ type: [Number], description: "Cat IDs to delete" })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  deleteIds?: number[];
}

// ── Birthday (age +1 by breed) ──────────────────────────────────

export class BirthdayDto {
  @ApiProperty({ description: "Breed to age up", example: "Persian" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  breed!: string;
}

// ── Preview Rename Breed ────────────────────────────────────────

export class PreviewBreedRenameDto {
  @ApiProperty({ description: "Current breed name", example: "Persian" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  from!: string;

  @ApiProperty({ description: "New breed name", example: "Persian Longhair" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  to!: string;
}
