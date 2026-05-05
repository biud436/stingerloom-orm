import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { envValidationSchema } from "./common/config/env.schema";
import { RequestContextMiddleware } from "./common/context/request-context.middleware";
import { AuthModule } from "./common/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: true },
    }),
    StingerloomOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const dbType = config.get<"mysql" | "postgres">("DB_TYPE", "mysql");
        const sync = config.get<string>("ORM_SYNC", "true");
        return {
          type: dbType,
          host: config.get<string>("DB_HOST"),
          port:
            config.get<number>("DB_PORT") ??
            (dbType === "postgres" ? 5432 : 3306),
          username: config.get<string>("DB_USER"),
          password: config.get<string>("DB_PASSWORD"),
          database: config.get<string>("DB_NAME"),
          entities: [__dirname + "/**/*.entity{.ts,.js}"],
          synchronize:
            sync === "false"
              ? false
              : sync === "safe"
                ? "safe"
                : sync === "dry-run"
                  ? "dry-run"
                  : true,
          logging: config.get<boolean>("DB_LOGGING", false),
        };
      },
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>("THROTTLE_TTL_MS", 60_000),
          limit: config.get<number>("THROTTLE_LIMIT", 120),
        },
      ],
    }),
    AuthModule,
    HealthModule,
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
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Open the per-request AsyncLocalStorage frame as early as possible so
    // every later layer (guards, services, ORM subscribers) sees the same
    // requestId.
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
