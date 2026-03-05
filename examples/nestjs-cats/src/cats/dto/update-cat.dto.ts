import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
  IsOptional,
  MaxLength,
} from "class-validator";

export class UpdateCatDto {
  @ApiPropertyOptional({ description: "고양이 이름", example: "Mittens" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: "고양이 나이", example: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  age?: number;

  @ApiPropertyOptional({ description: "고양이 품종", example: "Siamese" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  breed?: string;
}
