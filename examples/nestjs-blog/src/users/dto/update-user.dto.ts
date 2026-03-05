import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsEmail,
  IsOptional,
  MaxLength,
  MinLength,
} from "class-validator";

export class UpdateUserDto {
  @ApiPropertyOptional({ description: "Username (unique)", example: "janedoe" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  username?: string;

  @ApiPropertyOptional({
    description: "Email address (unique)",
    example: "jane@example.com",
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({
    description: "User biography",
    example: "Updated bio",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;
}
