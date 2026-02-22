import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  ParseIntPipe,
} from "@nestjs/common";
import { OwnersService } from "./owners.service";
import { CreateOwnerDto } from "./dto/create-owner.dto";

@Controller("owners")
export class OwnersController {
  constructor(private readonly ownersService: OwnersService) {}

  /** POST /owners — 주인 생성 (@Transactional, @BeforeInsert 훅 데모) */
  @Post()
  create(@Body() dto: CreateOwnerDto) {
    return this.ownersService.create(dto);
  }

  /** GET /owners — 주인 목록 (@OneToMany 관계 데모) */
  @Get()
  findAll() {
    return this.ownersService.findAll();
  }

  /** GET /owners/count — 주인 수 집계 */
  @Get("count")
  count() {
    return this.ownersService.count();
  }

  /** GET /owners/:id — 단건 조회 */
  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.ownersService.findOne(id);
  }

  /** DELETE /owners/:id — 영구 삭제 */
  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.ownersService.remove(id);
  }
}
