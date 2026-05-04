import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  Query,
  HttpCode,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SprintsService } from "./sprints.service";
import { CreateSprintDto, UpdateSprintDto } from "./dto/sprint.dto";

@ApiTags("Sprints")
@Controller("sprints")
export class SprintsController {
  constructor(private readonly service: SprintsService) {}

  @Post()
  create(@Body() dto: CreateSprintDto) {
    return this.service.create(dto);
  }

  @Get()
  list(@Query("projectId") projectId?: string) {
    return this.service.findAll(projectId ? Number(projectId) : undefined);
  }

  @Get(":id")
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateSprintDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
