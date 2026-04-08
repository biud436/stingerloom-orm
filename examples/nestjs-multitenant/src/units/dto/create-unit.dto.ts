import { ApiProperty } from "@nestjs/swagger";
import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateUnitDto {
  @ApiProperty({
    description: "활성 여부",
    example: true,
  })
  @IsBoolean()
  active!: boolean;

  @ApiProperty({
    description: "유닛 번호",
    example: "U-001",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(50)
  unitNumber!: string;
}
