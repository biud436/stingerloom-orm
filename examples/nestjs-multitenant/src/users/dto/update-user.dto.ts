import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsEmail, IsOptional, MinLength, MaxLength } from "class-validator";

export class UpdateUserDto {
  @ApiProperty({
    description: "사용자 이름",
    example: "hong_gildong_updated",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  username?: string;

  @ApiProperty({
    description: "이메일 주소",
    example: "newhong@example.com",
    required: false,
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    description: "자기소개",
    example: "수정된 자기소개입니다.",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;
}
