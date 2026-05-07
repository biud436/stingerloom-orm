import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Workspace } from "../workspaces/workspace.entity";
import { Project } from "../projects/project.entity";
import { Issue } from "../issues/issue.entity";
import { Comment } from "../comments/comment.entity";
import { Sprint } from "../sprints/sprint.entity";
import { Label } from "../labels/label.entity";
import { ProjectsModule } from "../projects/projects.module";
import { ImportExportService } from "./import-export.service";
import { ImportExportController } from "./import-export.controller";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([Workspace, Project, Issue, Comment, Sprint, Label]),
    ProjectsModule,
  ],
  controllers: [ImportExportController],
  providers: [ImportExportService],
  exports: [ImportExportService],
})
export class ImportExportModule {}
