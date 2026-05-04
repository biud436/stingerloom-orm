import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  Query,
  HttpCode,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { LabelsService } from "./labels.service";
import { CreateLabelDto } from "./dto/label.dto";

@ApiTags("Labels")
@Controller("labels")
export class LabelsController {
  constructor(private readonly service: LabelsService) {}

  @Post()
  create(@Body() dto: CreateLabelDto) {
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

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
