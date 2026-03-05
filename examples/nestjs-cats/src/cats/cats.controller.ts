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
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { CatsService } from "./cats.service";
import { CreateCatDto } from "./dto/create-cat.dto";
import { UpdateCatDto } from "./dto/update-cat.dto";
import { BulkCreateCatDto } from "./dto/bulk-create-cat.dto";
import { BulkDeleteCatDto } from "./dto/bulk-delete-cat.dto";

@ApiTags("cats")
@Controller("cats")
export class CatsController {
  constructor(private readonly catsService: CatsService) {}

  /** POST /cats -- 고양이 생성 (@Transactional, @BeforeInsert 훅 데모) */
  @Post()
  @ApiOperation({
    summary: "고양이 생성",
    description:
      "새 고양이를 생성합니다. @Transactional 범위 내에서 실행되며, @BeforeInsert 훅으로 createdAt/updatedAt이 자동 설정됩니다.",
  })
  @ApiResponse({ status: 201, description: "고양이가 성공적으로 생성됨" })
  @ApiResponse({ status: 400, description: "잘못된 요청 데이터" })
  create(@Body() createCatDto: CreateCatDto) {
    return this.catsService.create(createCatDto);
  }

  /** POST /cats/bulk -- 배치 INSERT (insertMany 데모) */
  @Post("bulk")
  @ApiOperation({
    summary: "고양이 배치 생성",
    description:
      "여러 고양이를 한 번의 INSERT 쿼리로 일괄 생성합니다 (insertMany).",
  })
  @ApiResponse({
    status: 201,
    description: "배치 생성 완료. affected 수 반환.",
  })
  bulkCreate(@Body() dto: BulkCreateCatDto) {
    return this.catsService.bulkCreate(dto.cats);
  }

  /** GET /cats -- soft-deleted 제외 목록 (자동 필터 데모) */
  @Get()
  @ApiOperation({
    summary: "고양이 목록 조회",
    description:
      "Soft-deleted 엔티티를 제외한 고양이 목록을 반환합니다 (deleted_at IS NULL 자동 필터).",
  })
  @ApiResponse({ status: 200, description: "고양이 목록 반환" })
  findAll() {
    return this.catsService.findAll();
  }

  /** GET /cats/all -- soft-deleted 포함 전체 목록 (withDeleted 데모) */
  @Get("all")
  @ApiOperation({
    summary: "전체 고양이 목록 조회 (soft-deleted 포함)",
    description:
      "Soft-deleted 엔티티를 포함한 전체 고양이 목록을 반환합니다 (withDeleted: true).",
  })
  @ApiResponse({
    status: 200,
    description: "soft-deleted 포함 전체 고양이 목록 반환",
  })
  findAllIncludeDeleted() {
    return this.catsService.findAllIncludeDeleted();
  }

  /** GET /cats/cursor -- 커서 기반 페이지네이션 (findWithCursor 데모) */
  @Get("cursor")
  @ApiOperation({
    summary: "커서 기반 페이지네이션",
    description:
      "커서 기반 페이지네이션으로 고양이 목록을 조회합니다. offset 방식 대신 커서를 사용하여 대량 데이터에서도 일정한 성능을 보장합니다.",
  })
  @ApiQuery({
    name: "take",
    required: false,
    type: Number,
    description: "한 페이지에 가져올 항목 수 (기본값: 10)",
    example: 10,
  })
  @ApiQuery({
    name: "cursor",
    required: false,
    type: String,
    description:
      "이전 응답의 nextCursor 값. 첫 페이지 요청 시 생략합니다.",
    example: "eyJpZCI6MTB9",
  })
  @ApiResponse({
    status: 200,
    description: "커서 페이지네이션 결과 (data, nextCursor, hasMore)",
  })
  findWithCursor(
    @Query("take") take?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.catsService.findWithCursor(
      take ? parseInt(take, 10) : undefined,
      cursor || undefined,
    );
  }

  /** GET /cats/stats -- 집계 쿼리 (count/avg/min/max/sum 데모) */
  @Get("stats")
  @ApiOperation({
    summary: "고양이 집계 통계",
    description:
      "고양이의 총 수, 평균 나이, 최소 나이, 최대 나이, 나이 합계를 반환합니다.",
  })
  @ApiResponse({
    status: 200,
    description:
      "집계 통계 반환 (total, avgAge, minAge, maxAge, sumAge)",
  })
  stats() {
    return this.catsService.stats();
  }

  /** GET /cats/:id -- 단건 조회 (@ManyToOne eager 로딩으로 owner 포함) */
  @Get(":id")
  @ApiOperation({
    summary: "고양이 단건 조회",
    description:
      "ID로 고양이를 조회합니다. @ManyToOne eager 로딩으로 owner 정보가 함께 반환됩니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "고양이 ID" })
  @ApiResponse({ status: 200, description: "고양이 정보 반환 (owner 포함)" })
  @ApiResponse({ status: 404, description: "해당 ID의 고양이를 찾을 수 없음" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.catsService.findOne(id);
  }

  /** PATCH /cats/:id -- 수정 (@Transactional, @BeforeUpdate 훅 데모) */
  @Patch(":id")
  @ApiOperation({
    summary: "고양이 수정",
    description:
      "고양이 정보를 부분 수정합니다. @Transactional 범위 내에서 실행되며, @BeforeUpdate 훅으로 updatedAt이 자동 갱신됩니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "고양이 ID" })
  @ApiResponse({ status: 200, description: "수정된 고양이 정보 반환" })
  @ApiResponse({ status: 404, description: "해당 ID의 고양이를 찾을 수 없음" })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() updateCatDto: UpdateCatDto,
  ) {
    return this.catsService.update(id, updateCatDto);
  }

  /** DELETE /cats/clear -- 테이블 전체 데이터 삭제 (TRUNCATE) */
  @Delete("clear")
  @ApiOperation({
    summary: "고양이 전체 삭제",
    description:
      "고양이 테이블의 모든 데이터를 제거합니다 (TRUNCATE TABLE).",
  })
  @ApiResponse({ status: 200, description: "테이블 데이터 전체 삭제 완료" })
  clear() {
    return this.catsService.clear();
  }

  /** DELETE /cats/bulk -- ID 배열로 배치 삭제 (deleteMany 데모) */
  @Delete("bulk")
  @ApiOperation({
    summary: "고양이 배치 삭제",
    description:
      "ID 배열로 여러 고양이를 한 번의 쿼리로 영구 삭제합니다 (deleteMany).",
  })
  @ApiResponse({
    status: 200,
    description: "배치 삭제 완료. affected 수 반환.",
  })
  removeMany(@Body() dto: BulkDeleteCatDto) {
    return this.catsService.removeMany(dto.ids);
  }

  /** DELETE /cats/:id -- 영구 삭제 */
  @Delete(":id")
  @ApiOperation({
    summary: "고양이 영구 삭제",
    description: "고양이를 데이터베이스에서 영구적으로 삭제합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "고양이 ID" })
  @ApiResponse({ status: 200, description: "고양이가 영구 삭제됨" })
  @ApiResponse({ status: 404, description: "해당 ID의 고양이를 찾을 수 없음" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.catsService.remove(id);
  }

  /** PATCH /cats/:id/soft-delete -- Soft Delete (deleted_at 기록, 행 유지) */
  @Patch(":id/soft-delete")
  @ApiOperation({
    summary: "고양이 Soft Delete",
    description:
      "고양이를 소프트 삭제합니다. deleted_at에 현재 시각이 기록되며, 행은 유지됩니다. find/findOne에서 자동으로 제외됩니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "고양이 ID" })
  @ApiResponse({ status: 200, description: "고양이가 soft-deleted 됨" })
  @ApiResponse({ status: 404, description: "해당 ID의 고양이를 찾을 수 없음" })
  softRemove(@Param("id", ParseIntPipe) id: number) {
    return this.catsService.softRemove(id);
  }

  /** PATCH /cats/:id/restore -- Soft Delete 복원 (deleted_at -> NULL) */
  @Patch(":id/restore")
  @ApiOperation({
    summary: "Soft Delete 복원",
    description:
      "Soft-deleted 고양이를 복원합니다. deleted_at을 NULL로 되돌립니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "고양이 ID" })
  @ApiResponse({ status: 200, description: "고양이가 복원됨" })
  restore(@Param("id", ParseIntPipe) id: number) {
    return this.catsService.restore(id);
  }

}
