import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { WorkspacesModule } from "./workspaces/workspaces.module";
import { UsersModule } from "./users/users.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { ProjectsModule } from "./projects/projects.module";
import { SprintsModule } from "./sprints/sprints.module";
import { IssuesModule } from "./issues/issues.module";
import { LabelsModule } from "./labels/labels.module";
import { CommentsModule } from "./comments/comments.module";
import { ActivityModule } from "./activity/activity.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { SearchModule } from "./search/search.module";
import { QueueModule } from "./queue/queue.module";

const dbType = (process.env.DB_TYPE ?? "mysql") as "mysql" | "postgres";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    StingerloomOrmModule.forRoot({
      type: dbType,
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || (dbType === "postgres" ? "5432" : "3306")),
      username: process.env.DB_USER || (dbType === "postgres" ? "postgres" : "root"),
      password: process.env.DB_PASSWORD || "password",
      database: process.env.DB_NAME || "linear_clone",
      entities: [__dirname + "/**/*.entity{.ts,.js}"],
      synchronize: true,
      logging: process.env.DB_LOGGING === "true",
    }),
    WorkspacesModule,
    UsersModule,
    MembershipsModule,
    ProjectsModule,
    SprintsModule,
    IssuesModule,
    LabelsModule,
    CommentsModule,
    ActivityModule,
    AnalyticsModule,
    SearchModule,
    QueueModule,
  ],
})
export class AppModule {}
