import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsOptional, IsInt, IsBoolean, Min, MinLength, MaxLength } from "class-validator";

export class CreatePostDto {
  @ApiProperty({
    description: "게시글 제목",
    example: "첫 번째 게시글",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    description: "게시글 내용",
    example: "멀티테넌시 환경에서 작성된 게시글입니다.",
  })
  @IsString()
  @IsNotEmpty()
  content!: string;

  @ApiProperty({
    description: "작성자 ID (User)",
    example: 1,
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  authorId?: number;

  @ApiProperty({
    description: "게시 여부",
    example: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  published?: boolean;
}
