import { Injectable } from "@nestjs/common";
import { MetadataContext } from "stingerloom-orm";

/**
 * Injectable NestJS service for accessing the current tenant context.
 *
 * Wraps the ORM's MetadataContext (AsyncLocalStorage-based) so that
 * any service or controller can inject this to get the current tenant
 * without directly depending on MetadataContext.
 *
 * @example
 * ```ts
 * @Injectable()
 * export class MyService {
 *   constructor(private readonly tenantContext: TenantContext) {}
 *
 *   doWork() {
 *     const tenant = this.tenantContext.getCurrentTenant();
 *     console.log(`Operating in tenant: ${tenant}`);
 *   }
 * }
 * ```
 */
@Injectable()
export class TenantContext {
  /**
   * Returns the current tenant ID from the AsyncLocalStorage context.
   * Falls back to "public" if no tenant context is active.
   */
  getCurrentTenant(): string {
    return MetadataContext.getCurrentTenant();
  }

  /**
   * Returns true if a tenant context is currently active
   * (i.e., the request passed through TenantMiddleware).
   */
  isActive(): boolean {
    return MetadataContext.isActive();
  }
}
