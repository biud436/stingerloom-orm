import "reflect-metadata";

import { NestFactory, Reflector } from "@nestjs/core";
import { ValidationPipe, ClassSerializerInterceptor } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { JwtService } from "@nestjs/jwt";
import { Logger } from "nestjs-pino";
import helmet from "helmet";
import { EntityManager } from "@stingerloom/orm";
import { AppModule } from "./app.module";
import { JwtAuthGuard } from "./common/auth/jwt-auth.guard";
import { AllExceptionsFilter } from "./common/exceptions/all-exceptions.filter";
import { EtagInterceptor } from "./common/concurrency/etag.interceptor";

async function bootstrap() {
  // bufferLogs: true queues early Nest bootstrap logs until pino is wired
  // up, so the very first lines aren't dropped or written via console.log.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.flushLogs();

  app.use(helmet());

  const corsOrigins = (config.get<string>("CORS_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length === 0 ? true : corsOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  // Order matters: ClassSerializerInterceptor runs first to strip `@Exclude`
  // fields (e.g. User.passwordHash); EtagInterceptor then sees the final
  // response shape, picks `version` for the ETag, and may short-circuit GET
  // to 304 on If-None-Match.
  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(reflector),
    new EtagInterceptor(),
  );

  // Global JWT guard — every endpoint is protected unless decorated `@Public()`.
  app.useGlobalGuards(new JwtAuthGuard(app.get(JwtService), reflector));

  app.enableShutdownHooks();

  // Stingerloom resource cleanup on SIGTERM/SIGINT (closes connection pools,
  // unregisters subscribers, drains query trackers).
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, draining…`);
    try {
      const em = app.get(EntityManager, { strict: false });
      await em?.propagateShutdown?.();
    } catch (err) {
      logger.error("propagateShutdown failed", err as Error);
    }
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const swagger = new DocumentBuilder()
    .setTitle("Linear Clone API")
    .setDescription(
      "Issue tracker showcasing recursive CTEs, window functions, full-text " +
        "search, JSON custom fields, FOR UPDATE SKIP LOCKED auto-assign, " +
        "optimistic locking via @Version, and EntitySubscriber-driven activity logging.",
    )
    .setVersion("1.0")
    .addBearerAuth()
    .addTag("Auth", "Login + JWT issuance")
    .addTag("Health", "Liveness / readiness probes")
    .addTag("Workspaces", "Tenant-like workspace CRUD")
    .addTag("Users", "User CRUD")
    .addTag("Memberships", "Workspace membership and roles")
    .addTag("Projects", "Project CRUD with custom-field schema")
    .addTag("Sprints", "Iteration / cycle management")
    .addTag("Issues", "Issue CRUD, version conflict detection, label assignment, subissue tree")
    .addTag("Labels", "Per-project labels")
    .addTag("Comments", "Issue comments")
    .addTag("Activity", "Audit trail")
    .addTag("Analytics", "Window functions and CTE-driven reports")
    .addTag("Search", "Full-text and JSON custom-field search")
    .addTag("Queue", "FOR UPDATE SKIP LOCKED auto-assign worker")
    .build();

  const document = SwaggerModule.createDocument(app, swagger);
  SwaggerModule.setup("api-docs", app, document);

  const port = config.get<number>("PORT") ?? 3000;
  await app.listen(port);
  logger.log(`Linear Clone API: http://localhost:${port}`);
  logger.log(`Swagger UI: http://localhost:${port}/api-docs`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal bootstrap error", err);
  process.exit(1);
});
