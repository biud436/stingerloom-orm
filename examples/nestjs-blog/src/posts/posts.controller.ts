import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from "@nestjs/swagger";
import { PostsService } from "./posts.service";
import { CreatePostDto } from "./dto/create-post.dto";
import { UpdatePostDto } from "./dto/update-post.dto";

@ApiTags("Posts")
@Controller("posts")
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post()
  @ApiOperation({ summary: "Create a post", description: "Create a new blog post." })
  @ApiResponse({ status: 201, description: "Post created successfully" })
  @ApiResponse({ status: 400, description: "Invalid input" })
  create(@Body() dto: CreatePostDto) {
    return this.postsService.create(dto);
  }

  /** upsert -- slug 기준 존재 시 업데이트, 없으면 삽입 */
  @Post("upsert")
  @ApiOperation({
    summary: "Upsert a post by slug",
    description: "slug 기준으로 존재하면 업데이트, 없으면 삽입합니다.",
  })
  @ApiResponse({ status: 201, description: "Post upserted successfully" })
  upsert(@Body() dto: CreatePostDto) {
    return this.postsService.upsertBySlug(dto);
  }

  /** findAndCount -- 페이지네이션 (total 포함) */
  @Get("paginated")
  @ApiOperation({
    summary: "Paginated post list",
    description: "findAndCount 기반 페이지네이션. Returns data array with total count and page info.",
  })
  @ApiQuery({ name: "page", required: false, type: Number, description: "Page number (default: 1)", example: 1 })
  @ApiQuery({ name: "limit", required: false, type: Number, description: "Items per page (default: 10)", example: 10 })
  @ApiResponse({ status: 200, description: "Paginated post list with total count" })
  findPaginated(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.postsService.findPaginated(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get()
  @ApiOperation({ summary: "Get all posts", description: "Retrieve all non-deleted posts." })
  @ApiResponse({ status: 200, description: "List of posts" })
  findAll() {
    return this.postsService.findAll();
  }

  @Get("all")
  @ApiOperation({
    summary: "Get all posts including soft-deleted",
    description: "Soft delete된 포스트를 포함한 전체 목록을 반환합니다.",
  })
  @ApiResponse({ status: 200, description: "List of all posts (including soft-deleted)" })
  findAllIncludeDeleted() {
    return this.postsService.findAllIncludeDeleted();
  }

  /** 커서 기반 페이지네이션 */
  @Get("cursor")
  @ApiOperation({
    summary: "Cursor-based pagination",
    description: "커서 기반 페이지네이션. Returns data, nextCursor, and hasMore.",
  })
  @ApiQuery({ name: "take", required: false, type: Number, description: "Number of items to fetch (default: 10)", example: 10 })
  @ApiQuery({ name: "cursor", required: false, type: String, description: "Cursor value from previous response" })
  @ApiResponse({ status: 200, description: "Cursor pagination result with data, nextCursor, hasMore" })
  findWithCursor(
    @Query("take") take?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.postsService.findWithCursor(
      take ? parseInt(take, 10) : undefined,
      cursor || undefined,
    );
  }

  /** Schema Diff -- 엔티티 vs DB 스키마 비교 */
  @Get("schema-diff")
  @ApiOperation({
    summary: "Schema Diff",
    description: "엔티티 메타데이터와 DB 스키마 차이를 반환합니다.",
  })
  @ApiResponse({ status: 200, description: "Schema diff information" })
  schemaDiff() {
    return this.postsService.getSchemaDiff();
  }

  /** Schema Diff Migration 파일 생성 */
  @Post("schema-diff/generate")
  @ApiOperation({
    summary: "Generate migration from Schema Diff",
    description: "Schema Diff 기반으로 Migration 파일 내용을 생성합니다.",
  })
  @ApiResponse({ status: 201, description: "Generated migration file content" })
  generateMigration() {
    return this.postsService.generateMigration();
  }

  /** explain -- 쿼리 실행 계획 */
  @Get(":id/explain")
  @ApiOperation({
    summary: "Explain query plan",
    description: "EXPLAIN을 사용하여 해당 포스트 조회 쿼리의 실행 계획을 반환합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "Post ID", example: 1 })
  @ApiResponse({ status: 200, description: "Query execution plan (EXPLAIN result)" })
  @ApiResponse({ status: 404, description: "Post not found" })
  explain(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.explainQuery(id);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a post by ID", description: "Retrieve a single post by its ID." })
  @ApiParam({ name: "id", type: Number, description: "Post ID", example: 1 })
  @ApiResponse({ status: 200, description: "Post found" })
  @ApiResponse({ status: 404, description: "Post not found" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a post", description: "Update a post by its ID." })
  @ApiParam({ name: "id", type: Number, description: "Post ID", example: 1 })
  @ApiResponse({ status: 200, description: "Post updated successfully" })
  @ApiResponse({ status: 404, description: "Post not found" })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdatePostDto,
  ) {
    return this.postsService.update(id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Hard delete a post", description: "Permanently delete a post by its ID." })
  @ApiParam({ name: "id", type: Number, description: "Post ID", example: 1 })
  @ApiResponse({ status: 200, description: "Post deleted" })
  @ApiResponse({ status: 404, description: "Post not found" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.remove(id);
  }

  @Patch(":id/soft-delete")
  @ApiOperation({
    summary: "Soft delete a post",
    description: "Soft delete 처리 (deletedAt 컬럼에 타임스탬프 설정). 복원 가능합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "Post ID", example: 1 })
  @ApiResponse({ status: 200, description: "Post soft-deleted" })
  @ApiResponse({ status: 404, description: "Post not found" })
  softRemove(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.softRemove(id);
  }

  @Patch(":id/restore")
  @ApiOperation({
    summary: "Restore a soft-deleted post",
    description: "Soft delete된 포스트를 복원합니다 (deletedAt을 null로 설정).",
  })
  @ApiParam({ name: "id", type: Number, description: "Post ID", example: 1 })
  @ApiResponse({ status: 200, description: "Post restored" })
  restore(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.restore(id);
  }

  /** GET /posts/:id/tags -- Post에 연결된 Tag 목록 조회 */
  @Get(":id/tags")
  @ApiOperation({
    summary: "Get tags for a post",
    description: "Post에 연결된 Tag 목록을 ManyToMany relations 로딩으로 반환합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "Post ID", example: 1 })
  @ApiResponse({ status: 200, description: "List of tags associated with the post" })
  @ApiResponse({ status: 404, description: "Post not found" })
  getPostTags(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.getPostTags(id);
  }

  /** POST /posts/:id/tags -- Post에 Tag 추가 (body: { tagId }) */
  @Post(":id/tags")
  @ApiOperation({
    summary: "Add a tag to a post",
    description: "중간 테이블(post_tags)에 (postId, tagId) 행을 삽입하여 ManyToMany 관계를 추가합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "Post ID", example: 1 })
  @ApiBody({
    schema: {
      type: "object",
      properties: { tagId: { type: "number", example: 1, description: "Tag ID to add" } },
      required: ["tagId"],
    },
  })
  @ApiResponse({ status: 201, description: "Tag added to post" })
  addTagToPost(
    @Param("id", ParseIntPipe) id: number,
    @Body("tagId", ParseIntPipe) tagId: number,
  ) {
    return this.postsService.addTagToPost(id, tagId);
  }

  /** DELETE /posts/:id/tags/:tagId -- Post에서 Tag 제거 */
  @Delete(":id/tags/:tagId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Remove a tag from a post",
    description: "중간 테이블(post_tags)에서 (postId, tagId) 행을 삭제하여 ManyToMany 관계를 제거합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "Post ID", example: 1 })
  @ApiParam({ name: "tagId", type: Number, description: "Tag ID to remove", example: 1 })
  @ApiResponse({ status: 200, description: "Tag removed from post" })
  removeTagFromPost(
    @Param("id", ParseIntPipe) id: number,
    @Param("tagId", ParseIntPipe) tagId: number,
  ) {
    return this.postsService.removeTagFromPost(id, tagId);
  }
}
