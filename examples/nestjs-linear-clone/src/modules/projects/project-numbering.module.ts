import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Project } from "./project.entity";
import { ProjectNumberingService } from "./project-numbering.service";

/**
 * Standalone home for the issue-number counter. Depends only on the
 * `Project` repository, so importing it never drags in `ProjectsModule`
 * (and the controller's back-edge to `IssuesModule`). That is what lets
 * `IssuesModule` and `ImportExportModule` import the counter without a
 * `forwardRef`.
 */
@Module({
  imports: [StingerloomOrmModule.forFeature([Project])],
  providers: [ProjectNumberingService],
  exports: [ProjectNumberingService],
})
export class ProjectNumberingModule {}
