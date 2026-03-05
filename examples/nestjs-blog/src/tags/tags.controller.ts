import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Query,
  ParseIntPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from "@nestjs/swagger";
import { TagsService } from "./tags.service";
import { CreateTagDto } from "./dto/create-tag.dto";

@ApiTags("Tags")
@Controller("tags")
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Post()
  @ApiOperation({ summary: "Create a tag", description: "Create a new tag." })
  @ApiResponse({ status: 201, description: "Tag created successfully" })
  @ApiResponse({ status: 400, description: "Invalid input" })
  create(@Body() dto: CreateTagDto) {
    return this.tagsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: "Get all tags", description: "Retrieve all tags." })
  @ApiResponse({ status: 200, description: "List of tags" })
  findAll() {
    return this.tagsService.findAll();
  }

  @Get("count")
  @ApiOperation({ summary: "Count tags", description: "Return total number of tags." })
  @ApiResponse({ status: 200, description: "Tag count as number" })
  count() {
    return this.tagsService.count();
  }

  /** upsert -- name 기준 태그 생성/업데이트 */
  @Post("upsert")
  @ApiOperation({
    summary: "Upsert a tag by name",
    description: "name 기준으로 태그를 생성하거나 업데이트합니다.",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: { name: { type: "string", example: "nestjs", description: "Tag name" } },
      required: ["name"],
    },
  })
  @ApiResponse({ status: 201, description: "Tag upserted successfully" })
  upsert(@Body("name") name: string) {
    return this.tagsService.upsertByName(name);
  }

  /** findAndCount -- 페이지네이션 */
  @Get("paginated")
  @ApiOperation({
    summary: "Paginated tag list",
    description: "findAndCount 기반 태그 페이지네이션. Returns data and total.",
  })
  @ApiQuery({ name: "page", required: false, type: Number, description: "Page number (default: 1)", example: 1 })
  @ApiQuery({ name: "limit", required: false, type: Number, description: "Items per page (default: 10)", example: 10 })
  @ApiResponse({ status: 200, description: "Paginated tag list with total count" })
  findPaginated(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.tagsService.findPaginated(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a tag by ID", description: "Retrieve a single tag by ID." })
  @ApiParam({ name: "id", type: Number, description: "Tag ID", example: 1 })
  @ApiResponse({ status: 200, description: "Tag found" })
  @ApiResponse({ status: 404, description: "Tag not found" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.tagsService.findOne(id);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a tag", description: "Permanently delete a tag by ID." })
  @ApiParam({ name: "id", type: Number, description: "Tag ID", example: 1 })
  @ApiResponse({ status: 200, description: "Tag deleted" })
  @ApiResponse({ status: 404, description: "Tag not found" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.tagsService.remove(id);
  }
}
