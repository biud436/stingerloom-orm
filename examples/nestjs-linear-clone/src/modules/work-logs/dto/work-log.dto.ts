import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsISO8601,
  Max,
  MinLength,
  MaxLength,
} from "class-validator";

export class CreateWorkLogDto {
  @ApiProperty({ description: "Hours worked (fractional allowed)", example: 1.5 })
  @IsNumber()
  @IsPositive()
  @Max(24)
  hours!: number;

  @ApiPropertyOptional({ description: "What was done" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: "Work date (ISO 8601). Defaults to now." })
  @IsOptional()
  @IsISO8601()
  loggedAt?: string;
}

export class UpdateWorkLogDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(24)
  hours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  loggedAt?: string;
}
