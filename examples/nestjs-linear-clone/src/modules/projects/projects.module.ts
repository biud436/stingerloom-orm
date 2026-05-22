import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Project } from "./project.entity";
import { ProjectsService } from "./projects.service";
import { ProjectsController } from "./projects.controller";
import { IssuesModule } from "../issues/issues.module";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([Project]),
    // Lets ProjectsController expose `/projects/:id/trash` (which delegates
    // to IssuesService.findTrash). IssuesModule depends on the issue-number
    // counter via ProjectNumberingModule, not ProjectsModule, so this edge
    // is one-way — a plain import, no forwardRef.
    IssuesModule,
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
