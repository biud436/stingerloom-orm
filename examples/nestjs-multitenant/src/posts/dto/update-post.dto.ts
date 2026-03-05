import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsOptional, IsBoolean, MinLength, MaxLength } from "class-validator";

export class UpdatePostDto {
  @ApiProperty({
    description: "게시글 제목",
    example: "수정된 제목",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiProperty({
    description: "게시글 내용",
    example: "수정된 내용입니다.",
    required: false,
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiProperty({
    description: "게시 여부",
    example: true,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  published?: boolean;
}
