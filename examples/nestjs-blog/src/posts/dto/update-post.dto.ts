import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  IsArray,
  Min,
  MaxLength,
  Matches,
} from "class-validator";
import { Type } from "class-transformer";

export class UpdatePostDto {
  @ApiPropertyOptional({ description: "Post title", example: "Updated Title" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({
    description: "URL-friendly slug (unique)",
    example: "updated-slug",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "slug must be a URL-friendly string (lowercase, hyphens only)",
  })
  slug?: string;

  @ApiPropertyOptional({
    description: "Post content body",
    example: "Updated content.",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  content?: string;

  @ApiPropertyOptional({ description: "Category ID", example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  categoryId?: number;

  @ApiPropertyOptional({
    description: "Tag ID array for ManyToMany association",
    example: [1, 3],
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Type(() => Number)
  tagIds?: number[];
}
