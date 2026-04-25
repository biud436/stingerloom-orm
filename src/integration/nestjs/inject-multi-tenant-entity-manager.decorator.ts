import { Inject } from "@nestjs/common";
import { MultiTenantEntityManager } from "../../core/MultiTenantEntityManager";

/**
 * Token for the per-connection `MultiTenantEntityManager`. Mirrors
 * `getEntityManagerToken()` so multi-DB setups can have one MTEM per named
 * connection (each MTEM owns its own router and tenant pools).
 */
export function getMultiTenantEntityManagerToken(
  connectionName = "default",
): string | typeof MultiTenantEntityManager {
  if (connectionName === "default") return MultiTenantEntityManager;
  return `STINGERLOOM_MULTI_TENANT_ENTITY_MANAGER_${connectionName}`;
}

/**
 * Inject the multi-tenant entity manager. Pair with
 * `StingerloomOrmModule.forRoot({ tenantStrategy: "database", ... })` to
 * route every request through `MetadataContext.getCurrentTenant()` to the
 * matching tenant pool.
 *
 * @example
 * ```ts
 * @Injectable()
 * export class UserService {
 *   constructor(
 *     @InjectMultiTenantEntityManager()
 *     private readonly em: MultiTenantEntityManager,
 *   ) {}
 *
 *   listUsers() {
 *     // Tenant context is set by middleware → routed to the right DB.
 *     return this.em.find(User);
 *   }
 * }
 * ```
 */
export const InjectMultiTenantEntityManager = (
  connectionName = "default",
): ParameterDecorator => {
  return Inject(getMultiTenantEntityManagerToken(connectionName));
};
