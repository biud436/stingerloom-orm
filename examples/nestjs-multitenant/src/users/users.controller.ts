import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiSecurity,
} from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

@ApiTags("Users")
@Controller("users")
@ApiSecurity("x-tenant-id")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({
    summary: "사용자 생성",
    description: "새로운 사용자를 생성합니다.",
  })
  @ApiResponse({ status: 201, description: "사용자가 성공적으로 생성됨" })
  @ApiResponse({ status: 400, description: "잘못된 요청 데이터" })
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: "전체 사용자 조회",
    description: "현재 테넌트의 모든 사용자를 조회합니다.",
  })
  @ApiResponse({ status: 200, description: "사용자 목록 반환" })
  findAll() {
    return this.usersService.findAll();
  }

  @Get(":id")
  @ApiOperation({
    summary: "사용자 단건 조회",
    description: "ID로 특정 사용자를 조회합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "사용자 ID" })
  @ApiResponse({ status: 200, description: "사용자 정보 반환" })
  @ApiResponse({ status: 404, description: "사용자를 찾을 수 없음" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.usersService.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "사용자 수정",
    description: "ID로 특정 사용자의 정보를 수정합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "사용자 ID" })
  @ApiResponse({ status: 200, description: "수정된 사용자 정보 반환" })
  @ApiResponse({ status: 404, description: "사용자를 찾을 수 없음" })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }

  @Delete(":id")
  @ApiOperation({
    summary: "사용자 삭제",
    description: "ID로 특정 사용자를 삭제합니다.",
  })
  @ApiParam({ name: "id", type: Number, description: "사용자 ID" })
  @ApiResponse({ status: 200, description: "사용자 삭제 완료" })
  @ApiResponse({ status: 404, description: "사용자를 찾을 수 없음" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.usersService.remove(id);
  }
}
