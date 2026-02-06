import "reflect-metadata";
// IMPORTANT: Initialize ORM scanners BEFORE any entities are imported

import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
  console.log(
    `🚀 Application is running on: http://localhost:${process.env.PORT ?? 3000}`,
  );
  console.log(`📝 Cats API: http://localhost:${process.env.PORT ?? 3000}/cats`);
}
bootstrap();
