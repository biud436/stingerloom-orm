import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { TenantModule } from "./tenant/tenant.module";
import { UsersModule } from "./users/users.module";
import { PostsModule } from "./posts/posts.module";
import { User } from "./users/user.entity";
import { Post } from "./posts/post.entity";
import { UsersController } from "./users/users.controller";
import { PostsController } from "./posts/posts.controller";
import { Unit } from "./units/unit.entity";
import { UnitsModule } from "./units/units.module";
import { SnakeNamingStrategy } from "@stingerloom/orm";
import { UnitsController } from "./units/units.controller";

@Module({
  imports: [
    ConfigModule.forRoot(),
    TenantModule.forRoot({
      headerName: "x-tenant-id",
      defaultTenant: "public",
      routes: [UsersController, PostsController, UnitsController],
    }),
    StingerloomOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres",
        host: config.get<string>("DB_HOST", "localhost"),
        port: parseInt(config.get<string>("DB_PORT", "5432"), 10),
        username: config.get<string>("DB_USER", "postgres"),
        password: config.get<string>("DB_PASSWORD", "postgres"),
        database: config.get<string>("DB_NAME", "multi_tenancy_db2"),
        entities: [User, Post, Unit],
        synchronize: true,
        logging: true,
        namingStrategy: new SnakeNamingStrategy(),
        tenantStrategy: "schema_qualified",
      }),
    }),
    UsersModule,
    PostsModule,
    UnitsModule,
  ],
})
export class AppModule {}
