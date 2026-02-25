import { Inject, Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "stingerloom-orm";
import { TENANT_MODULE_OPTIONS, TenantModuleOptions } from "./tenant.constants";

/**
 * Tenant Middleware
 *
 * Extracts the tenant ID from the configured request header
 * and wraps the request processing inside a MetadataContext.run() call.
 *
 * This ensures that all EntityManager operations within the request
 * automatically use the correct tenant's metadata layer via AsyncLocalStorage.
 *
 * The header name and default tenant are configurable via TenantModule.forRoot():
 *
 * @example
 * ```ts
 * // Default: reads "x-tenant-id" header, defaults to "public"
 * TenantModule.forRoot()
 *
 * // Custom: reads "x-org-id" header, defaults to "default"
 * TenantModule.forRoot({ headerName: 'x-org-id', defaultTenant: 'default' })
 * ```
 *
 * Usage:
 *   curl -H "x-tenant-id: tenant_1" http://localhost:3000/users
 *
 * If no tenant header is provided, the request runs in the
 * default tenant context ("public" by default).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly headerName: string;
  private readonly defaultTenant: string;

  constructor(
    @Inject(TENANT_MODULE_OPTIONS)
    private readonly options: TenantModuleOptions,
  ) {
    this.headerName = options.headerName || "x-tenant-id";
    this.defaultTenant = options.defaultTenant || "public";
  }

  use(req: Request, _res: Response, next: NextFunction) {
    const tenantId =
      (req.headers[this.headerName] as string) || this.defaultTenant;

    MetadataContext.run(tenantId, () => {
      next();
    });
  }
}
