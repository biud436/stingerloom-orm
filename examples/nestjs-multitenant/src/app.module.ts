import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { StinglerloomOrmModule } from "./stingerloom-orm/stingerloom-orm.module";
import { TenantModule } from "./tenant/tenant.module";
import { TenantMiddleware } from "./tenant/tenant.middleware";
import { UsersModule } from "./users/users.module";
import { PostsModule } from "./posts/posts.module";
import { User } from "./users/user.entity";
import { Post } from "./posts/post.entity";

@Module({
  imports: [
    TenantModule,
    UsersModule,
    PostsModule,
    StinglerloomOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432"),
      username: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      database: process.env.DB_NAME || "multitenant_db",
      entities: [User, Post],
      synchronize: true,
      logging: true,
    }),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
