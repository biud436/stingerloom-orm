import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from "class-validator";
import { CursorQueryDto } from "../../../common/dto/cursor.dto";

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

/**
 * Query contract for `GET /comments/cursor`. `issueId` must live inside the
 * DTO: the global ValidationPipe runs with `forbidNonWhitelisted`, so a
 * separate `@Query("issueId", ParseIntPipe)` binding left `issueId` outside
 * the DTO whitelist and 400'd the request. The workspace guard is unaffected
 * (it resolves the issue from the raw `req.query` before pipes run).
 */
export class CommentCursorQueryDto extends CursorQueryDto {
  @ApiProperty({ example: 1, description: "Issue whose comments to page through" })
  @Type(() => Number)
  @IsInt()
  issueId!: number;
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
