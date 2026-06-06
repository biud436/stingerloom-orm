import {
  Controller,
  Get,
  Query,
  BadRequestException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { SearchService } from "./search.service";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

/** Clamp a user-supplied `limit` to `[1, max]`, defaulting on missing/NaN. */
function clampLimit(raw: string | undefined, def: number, max: number): number {
  const n = raw !== undefined ? Number(raw) : def;
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}

@ApiTags("Search")
@ApiBearerAuth()
@Controller("search")
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get("issues")
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({
    summary: "Full-text search over issue title/description + comment body",
    description: "MySQL: MATCH AGAINST. PostgreSQL: to_tsvector + plainto_tsquery.",
  })
  @ApiQuery({ name: "q", required: true, example: "deadlock retry" })
  @ApiQuery({ name: "projectId", required: true })
  @ApiQuery({ name: "limit", required: false })
  async fullText(
    @Query("q") queryText: string,
    @Query("projectId") projectId: string,
    @Query("limit") limit?: string,
  ) {
    if (!queryText || queryText.trim().length < 2) {
      throw new BadRequestException("q must be at least 2 characters");
    }
    // `projectId` is required and membership-checked by @WorkspaceScoped, which
    // confines the search to one project the caller belongs to. Without it the
    // search returned issue/comment text across every tenant.
    if (!projectId) {
      throw new BadRequestException("projectId is required");
    }
    return this.service.fullTextIssues(
      queryText,
      Number(projectId),
      clampLimit(limit, 20, 100),
    );
  }

  @Get("by-custom-field")
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({
    summary: "Filter issues by JSON custom-field key/value",
    description: "PostgreSQL: customFields->>'key'. MySQL: JSON_UNQUOTE(JSON_EXTRACT(...)).",
  })
  @ApiQuery({ name: "projectId", required: true })
  @ApiQuery({ name: "key", required: true, example: "severity" })
  @ApiQuery({ name: "value", required: true, example: "S0" })
  byCustomField(
    @Query("projectId") projectId: string,
    @Query("key") key: string,
    @Query("value") value: string,
    @Query("limit") limit?: string,
  ) {
    if (!projectId || !key || !value) {
      throw new BadRequestException("projectId, key, value are all required");
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new BadRequestException("key must match identifier pattern");
    }
    return this.service.byCustomField(
      Number(projectId),
      key,
      value,
      clampLimit(limit, 50, 100),
    );
  }
}
