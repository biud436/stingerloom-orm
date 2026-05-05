import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { RequestContext, RequestContextStore } from "./request-context";

/**
 * Opens an AsyncLocalStorage frame for the request so any service / ORM
 * subscriber can read the caller's identity later without threading it
 * through every method signature.
 *
 * `requestId` is sourced from pino-http's `genReqId` (set on `req.id` by
 * the LoggerModule pino middleware), so logger output and ALS context share
 * a single id. Falls back to the inbound `x-request-id` header or a fresh
 * UUID for code paths that bypass pino-http (e.g. tests that mount the
 * middleware in isolation).
 *
 * Identity (`userId`, `workspaceId`) starts as `null` and is filled in by
 * downstream guards.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const fromPino = (req as Request & { id?: string }).id;
    const inbound = req.header("x-request-id");
    const requestId =
      typeof fromPino === "string" && fromPino.length > 0
        ? fromPino
        : inbound && /^[a-zA-Z0-9-]{1,64}$/.test(inbound)
          ? inbound
          : randomUUID();

    if (!res.getHeader("X-Request-Id")) {
      res.setHeader("X-Request-Id", requestId);
    }

    const ctx: RequestContext = {
      requestId,
      userId: null,
      workspaceId: null,
    };

    (req as Request & { context?: RequestContext }).context = ctx;

    RequestContextStore.run(ctx, () => next());
  }
}
