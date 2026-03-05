import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
  IsOptional,
  MaxLength,
} from "class-validator";

export class CreateCatDto {
  @ApiProperty({ description: "고양이 이름", example: "Whiskers" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: "고양이 나이", example: 3 })
  @IsInt()
  @Min(0)
  @Max(30)
  age!: number;

  @ApiProperty({ description: "고양이 품종", example: "Persian" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  breed!: string;

  /** 선택: 주인 ID. 지정 시 owner FK가 설정됩니다. */
  @ApiPropertyOptional({
    description: "주인 ID (선택). 지정 시 owner FK가 설정됩니다.",
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  ownerId?: number;
}
