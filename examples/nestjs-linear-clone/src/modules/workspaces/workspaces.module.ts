import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Workspace } from "./workspace.entity";
import { WorkspacesService } from "./workspaces.service";
import { WorkspacesController } from "./workspaces.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([Workspace])],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
