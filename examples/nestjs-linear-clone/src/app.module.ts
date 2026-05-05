import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { WorkspacesModule } from "./modules/workspaces/workspaces.module";
import { UsersModule } from "./modules/users/users.module";
import { MembershipsModule } from "./modules/memberships/memberships.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { SprintsModule } from "./modules/sprints/sprints.module";
import { IssuesModule } from "./modules/issues/issues.module";
import { LabelsModule } from "./modules/labels/labels.module";
import { CommentsModule } from "./modules/comments/comments.module";
import { ActivityModule } from "./modules/activity/activity.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { SearchModule } from "./modules/search/search.module";
import { QueueModule } from "./modules/queue/queue.module";

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
