import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsOptional, MaxLength } from "class-validator";

export class UpdateCategoryDto {
  @ApiPropertyOptional({
    description: "Category name",
    example: "Science",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: "Category description",
    example: "Posts about science and research",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
