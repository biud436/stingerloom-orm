import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  HttpCode,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import {
  WorkflowsService,
  encodeTransitionId,
} from "./workflows.service";
import { CreateTransitionDto } from "./dto/workflow.dto";
import { WorkspaceScoped } from "../../common/auth/workspace.decorators";

@ApiTags("Workflows")
@ApiBearerAuth()
@Controller("projects/:id/workflow")
export class WorkflowsController {
  constructor(private readonly service: WorkflowsService) {}

  @Get()
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({
    summary:
      "Get the workflow definition for a project. Auto-seeds the default Linear-style chain on first read.",
  })
  async get(@Param("id", ParseIntPipe) projectId: number) {
    const { definition, transitions } = await this.service.getOrSeed(projectId);
    return {
      id: definition.id,
      projectId: definition.projectId,
      states: definition.states,
      createdAt: definition.createdAt,
      transitions: transitions.map((t) => ({
        id: encodeTransitionId(t.fromState, t.toState),
        fromState: t.fromState,
        toState: t.toState,
        requiredRole: t.requiredRole,
        requiredFields: t.requiredFields,
        createdAt: t.createdAt,
      })),
    };
  }

  @Post("transitions")
  @WorkspaceScoped({ from: "project" })
  @ApiOperation({ summary: "Add a custom transition rule to the project workflow." })
  async addTransition(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: CreateTransitionDto,
  ) {
    const t = await this.service.addTransition(projectId, dto);
    return {
      id: encodeTransitionId(t.fromState, t.toState),
      fromState: t.fromState,
      toState: t.toState,
      requiredRole: t.requiredRole,
      requiredFields: t.requiredFields,
      createdAt: t.createdAt,
    };
  }

  @Delete("transitions/:transitionId")
  @WorkspaceScoped({ from: "project" })
  @HttpCode(204)
  @ApiOperation({
    summary:
      "Remove a transition rule. The transitionId is encoded as `${fromState}__${toState}`.",
  })
  removeTransition(
    @Param("id", ParseIntPipe) projectId: number,
    @Param("transitionId") transitionId: string,
  ) {
    return this.service.removeTransition(projectId, transitionId);
  }
}
