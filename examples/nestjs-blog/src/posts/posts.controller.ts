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
} from "@nestjs/common";
import { PostsService } from "./posts.service";
import { CreatePostDto } from "./dto/create-post.dto";
import { UpdatePostDto } from "./dto/update-post.dto";

@Controller("posts")
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post()
  create(@Body() dto: CreatePostDto) {
    return this.postsService.create(dto);
  }

  /** upsert — slug 기준 존재 시 업데이트, 없으면 삽입 */
  @Post("upsert")
  upsert(@Body() dto: CreatePostDto) {
    return this.postsService.upsertBySlug(dto);
  }

  /** findAndCount — 페이지네이션 (total 포함) */
  @Get("paginated")
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
  findAll() {
    return this.postsService.findAll();
  }

  @Get("all")
  findAllIncludeDeleted() {
    return this.postsService.findAllIncludeDeleted();
  }

  /** 커서 기반 페이지네이션 */
  @Get("cursor")
  findWithCursor(
    @Query("take") take?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.postsService.findWithCursor(
      take ? parseInt(take, 10) : undefined,
      cursor || undefined,
    );
  }

  /** Schema Diff — 엔티티 vs DB 스키마 비교 */
  @Get("schema-diff")
  schemaDiff() {
    return this.postsService.getSchemaDiff();
  }

  /** Schema Diff Migration 파일 생성 */
  @Post("schema-diff/generate")
  generateMigration() {
    return this.postsService.generateMigration();
  }

  /** explain — 쿼리 실행 계획 */
  @Get(":id/explain")
  explain(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.explainQuery(id);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.findOne(id);
  }

  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdatePostDto,
  ) {
    return this.postsService.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.remove(id);
  }

  @Patch(":id/soft-delete")
  softRemove(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.softRemove(id);
  }

  @Patch(":id/restore")
  restore(@Param("id", ParseIntPipe) id: number) {
    return this.postsService.restore(id);
  }
}
