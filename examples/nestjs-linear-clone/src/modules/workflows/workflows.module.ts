import { Module, forwardRef } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { WorkflowDefinition } from "./workflow-definition.entity";
import { WorkflowTransition } from "./workflow-transition.entity";
import { WorkflowsService } from "./workflows.service";
import { WorkflowsController } from "./workflows.controller";
import { ProjectsModule } from "../projects/projects.module";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([WorkflowDefinition, WorkflowTransition]),
    forwardRef(() => ProjectsModule),
  ],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
