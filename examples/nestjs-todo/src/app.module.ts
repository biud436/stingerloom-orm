import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { TodosModule } from "./todos/todos.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    StinglerloomOrmModule.forRoot({
      type: "mysql",
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "3306"),
      username: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "password",
      database: process.env.DB_NAME || "todo_db",
      entities: [__dirname + "/**/*.entity{.ts,.js}"],
      synchronize: true,
      logging: true,
    }),
    TodosModule,
  ],
})
export class AppModule {}
