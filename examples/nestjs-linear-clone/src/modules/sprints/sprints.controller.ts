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
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { SprintsService } from "./sprints.service";
import { CreateSprintDto, UpdateSprintDto } from "./dto/sprint.dto";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

@ApiTags("Sprints")
@ApiBearerAuth()
@Controller("sprints")
export class SprintsController {
  constructor(private readonly service: SprintsService) {}

  @Post()
  @WorkspaceScoped({ from: "project" })
  create(@Body() dto: CreateSprintDto) {
    return this.service.create(dto);
  }

  @Get()
  @WorkspaceScoped({ from: "project" })
  list(@Query("projectId") projectId: string) {
    return this.service.findAll(Number(projectId));
  }

  @Get(":id")
  @WorkspaceScoped({ from: "sprint" })
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch(":id")
  @WorkspaceScoped({ from: "sprint" })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateSprintDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  @WorkspaceScoped({ from: "sprint" })
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
