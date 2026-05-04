import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsString, IsOptional, MaxLength, Matches } from "class-validator";

export class CreateLabelDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  projectId!: number;

  @ApiProperty({ example: "regression" })
  @IsString()
  @MaxLength(40)
  name!: string;

  @ApiProperty({ required: false, example: "#ff5252" })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  color?: string;
}
