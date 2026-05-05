import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Issue } from "./issue.entity";
import { IssuesService } from "./issues.service";
import { IssuesController } from "./issues.controller";
import { ActivityModule } from "../activity/activity.module";
import { ProjectsModule } from "../projects/projects.module";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([Issue]),
    ActivityModule,
    ProjectsModule,
  ],
  controllers: [IssuesController],
  providers: [IssuesService],
  exports: [IssuesService],
})
export class IssuesModule {}
