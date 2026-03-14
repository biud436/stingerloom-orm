import { IsEmail, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CreateCustomerDto {
  @ApiProperty({ example: "alice@example.com" })
  @IsEmail()
  email: string;

  @ApiProperty({ example: "Alice" })
  @IsString()
  name: string;
}
