import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsEmail,
  IsOptional,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateUserDto {
  @ApiProperty({ description: "Username (unique)", example: "johndoe" })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  username!: string;

  @ApiProperty({
    description: "Email address (unique)",
    example: "john@example.com",
  })
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(255)
  email!: string;

  @ApiPropertyOptional({
    description: "User biography",
    example: "Full-stack developer",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;
}
