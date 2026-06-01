import { ApiProperty } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  ArrayMinSize,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateWebhookEndpointDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  workspaceId!: number;

  @ApiProperty({ example: "https://example.com/hooks/linear" })
  @IsString()
  @IsUrl({ require_tld: false })
  @MaxLength(512)
  url!: string;

  @ApiProperty({ example: "supersecret-shared-key" })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  secret!: string;

  @ApiProperty({
    example: ["issue.updated", "issue.created"],
    description: "Subscribed event types — exact-match against the emit() event name.",
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  events!: string[];

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateWebhookEndpointDto {
  @ApiProperty({
    example: 1,
    description:
      "Workspace the endpoint belongs to. Required for workspace-scope " +
      "authorization — the caller must be a member, and it must match the " +
      "endpoint's own workspace (cross-tenant patches are rejected). The " +
      "endpoint's workspace itself is immutable; this field is auth-only.",
  })
  @IsInt()
  workspaceId!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsUrl({ require_tld: false })
  @MaxLength(512)
  url?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  secret?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  events?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class TickResponseDto {
  @ApiProperty({ example: 3 })
  claimed!: number;

  @ApiProperty({ example: 2 })
  delivered!: number;

  @ApiProperty({ example: 1 })
  failed!: number;

  @ApiProperty({ example: 0 })
  permanentlyFailed!: number;
}
