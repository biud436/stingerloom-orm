import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsOptional, MaxLength } from "class-validator";

export class CreateCategoryDto {
  @ApiProperty({ description: "Category name", example: "Technology" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description: "Category description",
    example: "Posts about technology and software development",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
