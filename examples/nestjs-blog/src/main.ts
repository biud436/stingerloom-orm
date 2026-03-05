import "reflect-metadata";

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
    .setTitle("NestJS Blog API")
    .setDescription(
      "Blog REST API built with NestJS and Stingerloom ORM. " +
        "Supports CRUD, soft delete, upsert, cursor pagination, ManyToMany tags, schema diff, and more.",
    )
    .setVersion("1.0")
    .addTag("App", "Application root / schema diff demo")
    .addTag("Posts", "Blog post CRUD, soft delete, upsert, cursor pagination, ManyToMany tags")
    .addTag("Users", "User CRUD and pagination")
    .addTag("Tags", "Tag CRUD, upsert, and pagination")
    .addTag("Categories", "Category CRUD and GROUP BY stats")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api-docs", app, document);

  await app.listen(process.env.PORT ?? 3000);
  const port = process.env.PORT ?? 3000;
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Blog API: http://localhost:${port}/posts`);
  console.log(`Swagger UI: http://localhost:${port}/api-docs`);
}
bootstrap();
