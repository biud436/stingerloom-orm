import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { AuthService, IssuedToken } from "./auth.service";
import { Public } from "./public.decorator";

class RegisterDto {
  @ApiProperty({ example: "alice@example.com" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "alice" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name!: string;

  @ApiProperty({ example: "correct-horse-battery-staple" })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

class LoginDto {
  @ApiProperty({ example: "alice@example.com" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "correct-horse-battery-staple" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

class DevTokenDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  userId!: number;
}

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("register")
  @ApiOperation({ summary: "Register a new user" })
  register(@Body() dto: RegisterDto): Promise<IssuedToken> {
    return this.auth.register(dto);
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  @ApiOperation({ summary: "Exchange email + password for a JWT" })
  login(@Body() dto: LoginDto): Promise<IssuedToken> {
    return this.auth.login(dto);
  }

  /**
   * Tests + seed CLI use this to mint tokens without juggling passwords.
   * Disabled in production by `AuthService.issueDevToken`.
   */
  @Public()
  @Post("dev-token")
  @HttpCode(200)
  @ApiOperation({
    summary: "Mint a JWT for a user id (dev/test only)",
    description:
      "Returns 401 unless NODE_ENV != production AND AUTH_ALLOW_DEV_TOKEN=true.",
  })
  devToken(@Body() dto: DevTokenDto): Promise<IssuedToken> {
    return this.auth.issueDevToken(dto.userId);
  }
}
