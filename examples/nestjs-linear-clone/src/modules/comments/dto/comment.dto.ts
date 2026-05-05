import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsString, IsOptional, MinLength, MaxLength } from "class-validator";

export class CreateCommentDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  issueId!: number;

  @ApiProperty({ required: false, example: 1 })
  @IsOptional()
  @IsInt()
  authorId?: number;

  @ApiProperty({ example: "Reproduced on staging." })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  body!: string;
}

export class UpdateCommentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  body!: string;
}
