import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsEmail, MaxLength } from "class-validator";

export class CreateOwnerDto {
  @ApiProperty({ description: "주인 이름", example: "Kim" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: "주인 이메일",
    example: "kim@example.com",
  })
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(255)
  email!: string;
}
