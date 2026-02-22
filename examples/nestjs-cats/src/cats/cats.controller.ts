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
import { CatsService } from "./cats.service";
import { CreateCatDto } from "./dto/create-cat.dto";
import { UpdateCatDto } from "./dto/update-cat.dto";

@Controller("cats")
export class CatsController {
  constructor(private readonly catsService: CatsService) {}

  /** POST /cats — 고양이 생성 (@Transactional, @BeforeInsert 훅 데모) */
  @Post()
  create(@Body() createCatDto: CreateCatDto) {
    return this.catsService.create(createCatDto);
  }

  /** POST /cats/bulk — 배치 INSERT (insertMany 데모) */
  @Post("bulk")
  bulkCreate(@Body() dtos: CreateCatDto[]) {
    return this.catsService.bulkCreate(dtos);
  }

  /** GET /cats — soft-deleted 제외 목록 (자동 필터 데모) */
  @Get()
  findAll() {
    return this.catsService.findAll();
  }

  /** GET /cats/all — soft-deleted 포함 전체 목록 (withDeleted 데모) */
  @Get("all")
  findAllIncludeDeleted() {
    return this.catsService.findAllIncludeDeleted();
  }

  /** GET /cats/cursor — 커서 기반 페이지네이션 (findWithCursor 데모) */
  @Get("cursor")
  findWithCursor(
    @Query("take") take?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.catsService.findWithCursor(
      take ? parseInt(take, 10) : undefined,
      cursor || undefined,
    );
  }

  /** GET /cats/stats — 집계 쿼리 (count/avg/min/max/sum 데모) */
  @Get("stats")
  stats() {
    return this.catsService.stats();
  }

  /** GET /cats/:id — 단건 조회 (@ManyToOne eager 로딩으로 owner 포함) */
  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.catsService.findOne(id);
  }

  /** PATCH /cats/:id — 수정 (@Transactional, @BeforeUpdate 훅 데모) */
  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() updateCatDto: UpdateCatDto,
  ) {
    return this.catsService.update(id, updateCatDto);
  }

  /** DELETE /cats/:id — 영구 삭제 */
  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.catsService.remove(id);
  }

  /** PATCH /cats/:id/soft-delete — Soft Delete (deleted_at 기록, 행 유지) */
  @Patch(":id/soft-delete")
  softRemove(@Param("id", ParseIntPipe) id: number) {
    return this.catsService.softRemove(id);
  }

  /** PATCH /cats/:id/restore — Soft Delete 복원 (deleted_at → NULL) */
  @Patch(":id/restore")
  restore(@Param("id", ParseIntPipe) id: number) {
    return this.catsService.restore(id);
  }

  /** DELETE /cats/bulk — ID 배열로 배치 삭제 (deleteMany 데모) */
  @Delete("bulk")
  removeMany(@Body() ids: number[]) {
    return this.catsService.removeMany(ids);
  }
}
