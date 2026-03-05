import "reflect-metadata";
// IMPORTANT: Initialize ORM scanners BEFORE any entities are imported

import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  const config = new DocumentBuilder()
    .setTitle("Cats API")
    .setDescription(
      "NestJS Cats API with Stingerloom ORM -- CRUD, soft delete, cursor pagination, batch operations, aggregate stats",
    )
    .setVersion("1.0")
    .addTag("cats", "고양이 CRUD 및 관리")
    .addTag("owners", "주인 CRUD 및 관리")
    .addTag("app", "Application health check")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api-docs", app, document);

  await app.listen(process.env.PORT ?? 3000);
  const port = process.env.PORT ?? 3000;
  console.log(`🚀 Application is running on: http://localhost:${port}`);
  console.log(`📝 Cats API: http://localhost:${port}/cats`);
  console.log(`📖 Swagger UI: http://localhost:${port}/api-docs`);
}
bootstrap();
