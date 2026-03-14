import { IsEnum, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Category } from "../../generated";

export class CreateProductDto {
  @ApiProperty({ example: "Wireless Mouse" })
  @IsString()
  name: string;

  @ApiProperty({ example: 29.99 })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiPropertyOptional({ example: "A high-quality wireless mouse" })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 100 })
  @IsNumber()
  @Min(0)
  stock: number;

  @ApiProperty({ enum: Category, example: Category.ELECTRONICS })
  @IsEnum(Category)
  category: Category;
}
