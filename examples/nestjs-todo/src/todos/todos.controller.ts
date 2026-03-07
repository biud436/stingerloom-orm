import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from "@nestjs/swagger";
import { TodosService } from "./todos.service";
import { CreateTodoDto } from "./dto/create-todo.dto";
import { UpdateTodoDto } from "./dto/update-todo.dto";

@ApiTags("todos")
@Controller("todos")
export class TodosController {
  constructor(private readonly todosService: TodosService) {}

  @Post()
  @ApiOperation({ summary: "할 일 생성", description: "새로운 할 일을 생성합니다." })
  @ApiResponse({ status: 201, description: "할 일이 생성됨" })
  @ApiResponse({ status: 400, description: "잘못된 요청 데이터" })
  create(@Body() dto: CreateTodoDto) {
    return this.todosService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: "할 일 목록 조회", description: "Soft-deleted를 제외한 할 일 목록을 반환합니다." })
  @ApiResponse({ status: 200, description: "할 일 목록 반환" })
  findAll() {
    return this.todosService.findAll();
  }

  @Get(":id")
  @ApiOperation({ summary: "할 일 단건 조회", description: "ID로 할 일을 조회합니다." })
  @ApiParam({ name: "id", type: Number, description: "할 일 ID" })
  @ApiResponse({ status: 200, description: "할 일 정보 반환" })
  @ApiResponse({ status: 404, description: "해당 ID의 할 일을 찾을 수 없음" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.todosService.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "할 일 수정", description: "할 일 정보를 부분 수정합니다." })
  @ApiParam({ name: "id", type: Number, description: "할 일 ID" })
  @ApiResponse({ status: 200, description: "수정된 할 일 정보 반환" })
  @ApiResponse({ status: 404, description: "해당 ID의 할 일을 찾을 수 없음" })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateTodoDto,
  ) {
    return this.todosService.update(id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "할 일 Soft Delete", description: "할 일을 소프트 삭제합니다. deleted_at에 현재 시각이 기록됩니다." })
  @ApiParam({ name: "id", type: Number, description: "할 일 ID" })
  @ApiResponse({ status: 200, description: "할 일이 soft-deleted 됨" })
  @ApiResponse({ status: 404, description: "해당 ID의 할 일을 찾을 수 없음" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.todosService.softRemove(id);
  }
}
