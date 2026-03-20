import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  const config = new DocumentBuilder()
    .setTitle('Todo API')
    .setDescription(
      'NestJS Todo API with @stingerloom/orm (SQLite) — CRUD, soft delete, validation',
    )
    .setVersion('1.0')
    .addTag('todos', '할 일 CRUD 및 관리')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Todos API: http://localhost:${port}/todos`);
  console.log(`Swagger UI: http://localhost:${port}/api-docs`);
}
bootstrap();
