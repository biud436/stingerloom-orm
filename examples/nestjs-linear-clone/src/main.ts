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
    .setTitle("Linear Clone API")
    .setDescription(
      "Issue tracker showcasing recursive CTEs (issue trees), window functions " +
        "(burndown / throughput / time-in-state), full-text search, JSON custom " +
        "fields, FOR UPDATE SKIP LOCKED auto-assign, optimistic locking via @Version, " +
        "and EntitySubscriber-driven activity logging.",
    )
    .setVersion("1.0")
    .addTag("Workspaces", "Tenant-like workspace CRUD")
    .addTag("Users", "User CRUD")
    .addTag("Memberships", "Workspace membership and roles")
    .addTag("Projects", "Project CRUD with custom-field schema")
    .addTag("Sprints", "Iteration / cycle management")
    .addTag("Issues", "Issue CRUD, version conflict detection, label assignment, subissue tree")
    .addTag("Labels", "Per-project labels")
    .addTag("Comments", "Issue comments")
    .addTag("Activity", "Audit trail driven by EntitySubscriber")
    .addTag("Analytics", "Window functions and CTE-driven reports")
    .addTag("Search", "Full-text and JSON custom-field search")
    .addTag("Queue", "FOR UPDATE SKIP LOCKED auto-assign worker")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api-docs", app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Linear Clone API: http://localhost:${port}`);
  console.log(`Swagger UI: http://localhost:${port}/api-docs`);
}
bootstrap();
