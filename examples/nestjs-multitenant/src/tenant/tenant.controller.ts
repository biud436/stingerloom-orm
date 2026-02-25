import { Controller, Get } from "@nestjs/common";
import { TenantContext } from "./tenant-context.service";
import { Tenant } from "./tenant.decorator";

/**
 * Controller for tenant context inspection.
 * Useful for debugging and verifying tenant configuration.
 */
@Controller("tenant")
export class TenantController {
  constructor(private readonly tenantContext: TenantContext) {}

  /**
   * GET /tenant/current
   * Returns the current tenant information from the request context.
   */
  @Get("current")
  getCurrent(@Tenant() tenant: string) {
    return {
      tenant,
      isActive: this.tenantContext.isActive(),
    };
  }
}
