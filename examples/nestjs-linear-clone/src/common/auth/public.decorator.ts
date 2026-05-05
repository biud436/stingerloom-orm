import { SetMetadata } from "@nestjs/common";

export const PUBLIC_ROUTE = "auth:public";

/**
 * Marks a controller or handler as exempt from `JwtAuthGuard`.
 * Use sparingly: login endpoints, health probes, public docs.
 */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
