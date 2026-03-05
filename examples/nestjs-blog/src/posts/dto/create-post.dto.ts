import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
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

export class CreatePostDto {
  @ApiProperty({ description: "Post title", example: "My First Blog Post" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiProperty({
    description: "URL-friendly slug (unique)",
    example: "my-first-blog-post",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "slug must be a URL-friendly string (lowercase, hyphens only)",
  })
  slug!: string;

  @ApiProperty({
    description: "Post content body",
    example: "This is the content of my first blog post.",
  })
  @IsString()
  @IsNotEmpty()
  content!: string;

  @ApiProperty({ description: "Author user ID", example: 1 })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  authorId!: number;

  @ApiPropertyOptional({ description: "Category ID", example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  categoryId?: number;

  @ApiPropertyOptional({
    description: "Tag ID array for ManyToMany association",
    example: [1, 2],
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Type(() => Number)
  tagIds?: number[];
}
