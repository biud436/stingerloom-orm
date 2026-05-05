import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from "class-validator";

export class CreateCommentDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  issueId!: number;

  @ApiProperty({ example: "Reproduced on staging." })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  body!: string;

  @ApiPropertyOptional({
    example: 42,
    description: "Make this a reply to another comment on the same issue.",
  })
  @IsOptional()
  @IsInt()
  parentCommentId?: number | null;
}

export class UpdateCommentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  body!: string;
}

export class AddReactionDto {
  @ApiProperty({ example: "👍" })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  // Reject whitespace / control chars so the URL form (DELETE /:emoji) stays sane.
  @Matches(/^\S+$/, { message: "emoji must not contain whitespace" })
  emoji!: string;
}
