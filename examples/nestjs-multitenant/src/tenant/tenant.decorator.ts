import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { MetadataContext } from "@stingerloom/orm";

/**
 * Parameter decorator that extracts the current tenant ID from
 * the AsyncLocalStorage context set by TenantMiddleware.
 *
 * Use this instead of `@Headers("x-tenant-id")` for cleaner controller code.
 *
 * @example
 * ```ts
 * @Get()
 * findAll(@Tenant() tenant: string) {
 *   console.log(`Current tenant: ${tenant}`);
 *   return this.usersService.findAll();
 * }
 * ```
 */
export const Tenant = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): string => {
    return MetadataContext.getCurrentTenant();
  },
);
