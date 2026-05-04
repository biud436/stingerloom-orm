import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  HttpCode,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { WorkspacesService } from "./workspaces.service";
import { CreateWorkspaceDto, UpdateWorkspaceDto } from "./dto/workspace.dto";

@ApiTags("Workspaces")
@Controller("workspaces")
export class WorkspacesController {
  constructor(private readonly service: WorkspacesService) {}

  @Post()
  @ApiOperation({ summary: "Create a workspace" })
  create(@Body() dto: CreateWorkspaceDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: "List all workspaces" })
  list() {
    return this.service.findAll();
  }

  @Get(":id")
  @ApiOperation({ summary: "Get workspace by id" })
  one(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update workspace" })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateWorkspaceDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete workspace" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
