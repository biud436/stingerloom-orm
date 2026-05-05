import "reflect-metadata";
import {
  INestApplication,
  ValidationPipe,
  ClassSerializerInterceptor,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { EntityManager, sql } from "@stingerloom/orm";
import { AppModule } from "../../src/app.module";
import { JwtAuthGuard } from "../../src/common/auth/jwt-auth.guard";
import { AllExceptionsFilter } from "../../src/common/exceptions/all-exceptions.filter";

export const integrationDescribe = process.env.INTEGRATION_TEST
  ? describe
  : describe.skip;

export const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

export interface BootedApp {
  app: INestApplication;
  server: any;
  em: EntityManager;
}

/**
 * Boot the full Nest app with the same wiring as production: the global
 * JWT guard, exception filter, validation pipe, and serializer interceptor.
 *
 * Environment hardening applied here:
 *   - `AUTH_ALLOW_DEV_TOKEN=true` so tests can mint JWTs via `/auth/dev-token`.
 *   - Once the app is bootstrapped, we wait for the schema sync to settle by
 *     polling `SELECT 1` instead of a fixed `setTimeout` — that removed a
 *     ~2.5s flake-prone sleep.
 */
export async function bootApp(): Promise<BootedApp> {
  process.env.AUTH_ALLOW_DEV_TOKEN = "true";
  process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = "test-only-secret-must-be-at-least-32-chars-long";
  }

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(new ClassSerializerInterceptor(reflector));
  app.useGlobalGuards(new JwtAuthGuard(app.get(JwtService), reflector));

  await app.init();

  const em = app.get(EntityManager);
  // Ensure the schema sync has settled — `synchronize: true` runs on init
  // but DDL can race the first request. Poll instead of `setTimeout`.
  await waitForReady(em, 10_000);

  return { app, server: app.getHttpServer(), em };
}

async function waitForReady(em: EntityManager, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await em.query(sql`SELECT 1 AS ok`);
      return;
    } catch (err) {
      lastErr = err;
      await wait(150);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("DB not ready in time");
}

export async function shutdownApp(booted: BootedApp | undefined): Promise<void> {
  if (!booted) return;
  await booted.em?.propagateShutdown?.();
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

/**
 * Mint a JWT for a user id via the `/auth/dev-token` endpoint, side-stepping
 * password handling. Tests use this to bake an `Authorization: Bearer <jwt>`
 * header for subsequent calls.
 */
export async function mintToken(server: any, userId: number): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const request = require("supertest");
  const r = await request(server)
    .post("/auth/dev-token")
    .send({ userId })
    .expect(200);
  return r.body.accessToken as string;
}

/**
 * Convenience: `auth(server, token)` returns a supertest agent that already
 * has the bearer header set, so spec files can write
 * `await api.get('/issues').expect(200)` without repeating the header.
 */
export function authedAgent(server: any, token: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const request = require("supertest");
  const agent = request.agent(server);
  agent.set("Authorization", `Bearer ${token}`);
  return agent;
}
