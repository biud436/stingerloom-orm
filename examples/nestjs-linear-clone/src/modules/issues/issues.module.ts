import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Issue } from "./issue.entity";
import { IssuesService } from "./issues.service";
import { IssuesController } from "./issues.controller";
import { IssueAuditSubscriber } from "./issue-audit.subscriber";
import { ActivityModule } from "../activity/activity.module";
import { ProjectsModule } from "../projects/projects.module";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([Issue]),
    ActivityModule,
    ProjectsModule,
  ],
  controllers: [IssuesController],
  providers: [IssuesService, IssueAuditSubscriber],
  exports: [IssuesService],
})
export class IssuesModule {}
