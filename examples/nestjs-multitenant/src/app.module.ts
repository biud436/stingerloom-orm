import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { TenantModule } from "./tenant/tenant.module";
import { UsersModule } from "./users/users.module";
import { PostsModule } from "./posts/posts.module";
import { User } from "./users/user.entity";
import { Post } from "./posts/post.entity";
import { UsersController } from "./users/users.controller";
import { PostsController } from "./posts/posts.controller";

@Module({
  imports: [
    ConfigModule.forRoot(),
    TenantModule.forRoot({
      headerName: "x-tenant-id",
      defaultTenant: "public",
      routes: [UsersController, PostsController],
    }),
    StinglerloomOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432"),
      username: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      database: process.env.DB_NAME || "multi_tenancy_db2",
      entities: [User, Post],
      synchronize: true,
      logging: true,
    }),
    UsersModule,
    PostsModule,
  ],
})
export class AppModule {}
