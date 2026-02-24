import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "stingerloom-orm";

/**
 * Tenant Middleware
 *
 * Extracts the tenant ID from the `x-tenant-id` request header
 * and wraps the request processing inside a MetadataContext.run() call.
 *
 * This ensures that all EntityManager operations within the request
 * use the correct tenant's metadata layer.
 *
 * Usage:
 *   curl -H "x-tenant-id: tenant_1" http://localhost:3000/users
 *
 * If no x-tenant-id header is provided, the request runs in the
 * "public" (default) tenant context.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const tenantId = req.headers["x-tenant-id"] as string | undefined;

    if (tenantId) {
      MetadataContext.run(tenantId, () => {
        next();
      });
    } else {
      next();
    }
  }
}
