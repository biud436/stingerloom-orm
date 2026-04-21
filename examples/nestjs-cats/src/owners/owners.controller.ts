import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  ParseIntPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from "@nestjs/swagger";
import { OwnersService } from "./owners.service";
import { CreateOwnerDto } from "./dto/create-owner.dto";

@ApiTags("owners")
@Controller("owners")
export class OwnersController {
  constructor(private readonly ownersService: OwnersService) {}

  /** POST /owners -- create an owner (@Transactional, @BeforeInsert hook demo) */
  @Post()
  @ApiOperation({
    summary: "주인 생성",
    description:
      "새 주인을 생성합니다. @Transactional 범위 내에서 실행되며, @BeforeInsert 훅으로 createdAt이 자동 설정됩니다.",
  })
  @ApiResponse({ status: 201, description: "주인이 성공적으로 생성됨" })
  @ApiResponse({ status: 400, description: "잘못된 요청 데이터" })
  create(@Body() dto: CreateOwnerDto) {
    return this.ownersService.create(dto);
  }

  /** GET /owners -- list owners (@OneToMany relation demo) */
  @Get()
  @ApiOperation({
    summary: "주인 목록 조회",
    description:
      "전체 주인 목록을 반환합니다. @OneToMany 관계를 통해 소유한 고양이 정보도 조회할 수 있습니다.",
  })
  @ApiResponse({ status: 200, description: "주인 목록 반환" })
  findAll() {
    return this.ownersService.findAll();
  }

  /** GET /owners/count -- aggregate owner count */
  @Get("count")
  @ApiOperation({
    summary: "주인 수 집계",
    description: "등록된 주인의 총 수를 반환합니다.",
  })
  @ApiResponse({ status: 200, description: "주인 총 수 반환" })
  count() {
    return this.ownersService.count();
  }

  /** GET /owners/:id -- find one */
  @Get(":id")
  @ApiOperation({
    summary: "주인 단건 조회",
    description: "ID로 주인을 조회합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "주인 ID" })
  @ApiResponse({ status: 200, description: "주인 정보 반환" })
  @ApiResponse({ status: 404, description: "해당 ID의 주인을 찾을 수 없음" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.ownersService.findOne(id);
  }

  /** DELETE /owners/:id -- hard delete */
  @Delete(":id")
  @ApiOperation({
    summary: "주인 영구 삭제",
    description: "주인을 데이터베이스에서 영구적으로 삭제합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "주인 ID" })
  @ApiResponse({ status: 200, description: "주인이 영구 삭제됨" })
  @ApiResponse({ status: 404, description: "해당 ID의 주인을 찾을 수 없음" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.ownersService.remove(id);
  }
}
