import "reflect-metadata";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";

export const integrationDescribe = process.env.INTEGRATION_TEST
  ? describe
  : describe.skip;

export const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

export interface BootedApp {
  app: INestApplication;
  server: any;
}

/**
 * Boot the full Nest app with the same pipes as `main.ts`. Each spec file
 * gets its own instance so failures stay isolated, while jest's
 * `maxWorkers: 1` keeps the DB connection pool sane.
 */
export async function bootApp(): Promise<BootedApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  // Allow synchronize: true to settle (CREATE TABLE IF NOT EXISTS, etc.)
  await wait(2500);

  return { app, server: app.getHttpServer() };
}

export async function shutdownApp(booted: BootedApp | undefined): Promise<void> {
  if (!booted) return;
  await booted.app.close();
}

/**
 * Test-isolation helper: every spec file derives a unique suffix from its
 * own monotonic timestamp + random salt so workspace slugs / project keys /
 * user emails do not collide between files.
 */
export function uniqueSuffix(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Build a project key matching the controller's regex `^[A-Z][A-Z0-9]{1,5}$`. */
export function projectKey(suffix: string): string {
  return ("P" + suffix.toUpperCase().replace(/[^A-Z0-9]/g, "")).slice(0, 6);
}
