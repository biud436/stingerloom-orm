import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, MaxLength } from "class-validator";

export class CreateTagDto {
  @ApiProperty({ description: "Tag name (unique)", example: "typescript" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}
