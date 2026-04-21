import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { bufferPlugin } from "@stingerloom/orm";
import { CatsModule } from "./cats/cats.module";
import { OwnersModule } from "./owners/owners.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    StingerloomOrmModule.forRoot({
      type: "mysql",
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "3306"),
      username: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "password",
      database: process.env.DB_NAME || "cats_db",
      entities: [__dirname + "/**/*.entity{.ts,.js}"],
      synchronize: true,
      logging: true,
      plugins: [
        bufferPlugin({
          logging: true,
        }),
      ],
    }),
    CatsModule,
    OwnersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
