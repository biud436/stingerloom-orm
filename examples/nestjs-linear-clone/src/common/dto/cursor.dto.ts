import { IsOptional, IsString, IsInt, Min, Max } from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Standard cursor pagination query string parameters.
 *
 * Cursors are opaque base64 payloads minted by Stingerloom's `findWithCursor`
 * — clients should not parse them, only echo them back as `?cursor=…` to
 * fetch the next page.
 *
 * The global ValidationPipe runs with `forbidNonWhitelisted`, and a DTO-bound
 * `@Query()` receives the WHOLE query object — so an endpoint that takes any
 * extra query parameter must declare it on a subclass of this DTO (see
 * ProjectCursorQueryDto / CommentCursorQueryDto) instead of adding a separate
 * `@Query("name")` binding, which would 400 every request.
 */
export class CursorQueryDto {
  @ApiPropertyOptional({ description: "Opaque cursor from a previous page's nextCursor" })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: "Page size (1-100, default 20)", default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}
