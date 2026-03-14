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
    .setTitle("E-commerce API")
    .setDescription(
      "NestJS E-commerce API with Stingerloom ORM — entities generated from Prisma schema",
    )
    .setVersion("1.0")
    .addTag("customers", "Customer CRUD")
    .addTag("products", "Product CRUD")
    .addTag("orders", "Order CRUD")
    .addTag("app", "Health check")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api-docs", app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger UI: http://localhost:${port}/api-docs`);
}
bootstrap();
