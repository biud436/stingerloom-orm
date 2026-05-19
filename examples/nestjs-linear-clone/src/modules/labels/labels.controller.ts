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
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { LabelsService } from "./labels.service";
import { CreateLabelDto } from "./dto/label.dto";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

@ApiTags("Labels")
@ApiBearerAuth()
@Controller("labels")
export class LabelsController {
  constructor(private readonly service: LabelsService) {}

  @Post()
  @WorkspaceScoped({ from: "project" })
  create(@Body() dto: CreateLabelDto) {
    return this.service.create(dto);
  }

  @Get()
  @WorkspaceScoped({ from: "project" })
  list(@Query("projectId") projectId: string) {
    return this.service.findAll(Number(projectId));
  }

  @Get(":id")
  @WorkspaceScoped({ from: "label" })
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Delete(":id")
  @WorkspaceScoped({ from: "label" })
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
