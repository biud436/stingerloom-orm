import {
  Controller,
  Get,
  Query,
  BadRequestException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { SearchService } from "./search.service";

@ApiTags("Search")
@Controller("search")
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get("issues")
  @ApiOperation({
    summary: "Full-text search over issue title/description + comment body",
    description: "MySQL: MATCH AGAINST. PostgreSQL: to_tsvector + plainto_tsquery.",
  })
  @ApiQuery({ name: "q", required: true, example: "deadlock retry" })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "limit", required: false })
  async fullText(
    @Query("q") queryText: string,
    @Query("projectId") projectId?: string,
    @Query("limit") limit?: string,
  ) {
    if (!queryText || queryText.trim().length < 2) {
      throw new BadRequestException("q must be at least 2 characters");
    }
    return this.service.fullTextIssues(
      queryText,
      projectId ? Number(projectId) : undefined,
      limit ? Number(limit) : 20,
    );
  }

  @Get("by-custom-field")
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
      limit ? Number(limit) : 50,
    );
  }
}
