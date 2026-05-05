import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { RequestContext, RequestContextStore } from "./request-context";

/**
 * First middleware in the chain. Mints (or trusts) a `requestId`, opens an
 * AsyncLocalStorage frame for this request, and exposes the id on the
 * response as `X-Request-Id` so clients can correlate.
 *
 * Identity (`userId`, `workspaceId`) starts as `null` and is filled in by
 * downstream guards.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header("x-request-id");
    const requestId = inbound && /^[a-zA-Z0-9-]{1,64}$/.test(inbound) ? inbound : randomUUID();

    res.setHeader("X-Request-Id", requestId);

    const ctx: RequestContext = {
      requestId,
      userId: null,
      workspaceId: null,
    };

    (req as Request & { context?: RequestContext }).context = ctx;

    RequestContextStore.run(ctx, () => next());
  }
}
