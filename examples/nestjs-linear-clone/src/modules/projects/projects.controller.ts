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
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { ProjectsService } from "./projects.service";
import { CreateProjectDto, UpdateProjectDto } from "./dto/project.dto";

@ApiTags("Projects")
@Controller("projects")
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  @Post()
  create(@Body() dto: CreateProjectDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: "List projects (optionally filtered by workspaceId)" })
  list(@Query("workspaceId") workspaceId?: string) {
    return this.service.findAll(workspaceId ? Number(workspaceId) : undefined);
  }

  @Get(":id")
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateProjectDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
