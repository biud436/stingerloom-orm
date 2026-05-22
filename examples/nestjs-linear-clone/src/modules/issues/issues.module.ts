import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Issue } from "./issue.entity";
import { IssuesService } from "./issues.service";
import { IssuesController } from "./issues.controller";
import { IssueAuditSubscriber } from "./issue-audit.subscriber";
import { ActivityModule } from "../activity/activity.module";
import { ProjectNumberingModule } from "../projects/project-numbering.module";
import { WorkflowsModule } from "../workflows/workflows.module";
import { WebhooksModule } from "../webhooks/webhooks.module";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([Issue]),
    ActivityModule,
    // All plain imports — IssuesService depends only on the narrow surface
    // of each (ProjectNumberingService, WorkflowsService, WebhooksService),
    // and none of those modules import IssuesModule back, so there is no
    // cycle left to break with forwardRef.
    ProjectNumberingModule,
    WorkflowsModule,
    WebhooksModule,
  ],
  controllers: [IssuesController],
  providers: [IssuesService, IssueAuditSubscriber],
  exports: [IssuesService],
})
export class IssuesModule {}
