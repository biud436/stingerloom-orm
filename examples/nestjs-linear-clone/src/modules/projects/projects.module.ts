import { Module, forwardRef } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Project } from "./project.entity";
import { ProjectsService } from "./projects.service";
import { ProjectsController } from "./projects.controller";
import { IssuesModule } from "../issues/issues.module";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([Project]),
    // Lets ProjectsController expose `/projects/:id/trash` (which delegates
    // to IssuesService.findTrash). IssuesModule already imports
    // ProjectsModule (for ProjectsService), so the back-edge needs forwardRef.
    forwardRef(() => IssuesModule),
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
