import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsEmail, IsOptional, IsNotEmpty, MinLength, MaxLength } from "class-validator";

export class CreateUserDto {
  @ApiProperty({
    description: "사용자 이름",
    example: "hong_gildong",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  username!: string;

  @ApiProperty({
    description: "이메일 주소",
    example: "hong@example.com",
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    description: "자기소개",
    example: "안녕하세요, 홍길동입니다.",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;
}
