import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { RequestContextStore } from "../context/request-context";
import { QueryTrackerBridge } from "./query-tracker.bridge";

/**
 * pino-http drives both global Nest logs and per-request HTTP access lines.
 *
 * - `genReqId` honors an inbound `X-Request-Id` (subject to the same
 *   character whitelist as RequestContextMiddleware) and falls back to a
 *   fresh UUID. The chosen id is mirrored back as a response header.
 * - `customProps` reads the active RequestContext on every log call so
 *   downstream service / controller / ORM-subscriber logs all carry the same
 *   `requestId` / `userId` / `workspaceId` without manual threading.
 * - `redact` strips Authorization headers from access logs to keep bearer
 *   tokens out of stdout.
 *
 * QueryTrackerBridge subscribes to the ORM's slow-query / N+1 events at
 * module init and emits them as structured `db.slow_query` / `db.n_plus_one`
 * lines through the same pino logger.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>("LOG_LEVEL", "info"),
          autoLogging: {
            ignore: (req: Request) => {
              // Health probes flood the log; suppress 200 lines.
              return req.url === "/healthz" || req.url === "/readyz";
            },
          },
          genReqId: (req: Request, res: Response) => {
            const inbound = req.headers["x-request-id"];
            const candidate =
              typeof inbound === "string" &&
              /^[a-zA-Z0-9-]{1,64}$/.test(inbound)
                ? inbound
                : randomUUID();
            res.setHeader("X-Request-Id", candidate);
            return candidate;
          },
          customProps: () => {
            const ctx = RequestContextStore.get();
            if (!ctx) return {};
            return {
              requestId: ctx.requestId,
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
            };
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
            ],
            censor: "[REDACTED]",
          },
          transport:
            config.get<string>("NODE_ENV", "development") === "development"
              ? {
                  target: "pino-pretty",
                  options: {
                    singleLine: true,
                    translateTime: "HH:MM:ss.l",
                    ignore: "pid,hostname,req,res,responseTime",
                    messageFormat:
                      "[{requestId}] {context} - {msg}",
                  },
                }
              : undefined,
        },
      }),
    }),
  ],
  providers: [QueryTrackerBridge],
  exports: [LoggerModule, QueryTrackerBridge],
})
export class ObservabilityModule {}
