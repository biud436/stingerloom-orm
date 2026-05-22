import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { WorkflowDefinition } from "./workflow-definition.entity";
import { WorkflowTransition } from "./workflow-transition.entity";
import { WorkflowsService } from "./workflows.service";
import { WorkflowsController } from "./workflows.controller";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([WorkflowDefinition, WorkflowTransition]),
  ],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
