import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsOptional, MaxLength, MinLength, Matches } from "class-validator";

export class CreateWorkspaceDto {
  @ApiProperty({ example: "Acme Corp" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: "acme" })
  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  @MaxLength(40)
  slug!: string;
}

export class UpdateWorkspaceDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}
