import { Module } from "@nestjs/common";
import { TenantContextInterceptor } from "./tenant-context.interceptor";

/**
 * Exposes `TenantContextInterceptor` so `main.ts` and the e2e test harness
 * can pull a single shared instance via `app.get(TenantContextInterceptor)`.
 * Registered globally rather than per-controller so every workspace-scoped
 * route receives a `MetadataContext.run(...)` frame transparently.
 */
@Module({
  providers: [TenantContextInterceptor],
  exports: [TenantContextInterceptor],
})
export class TenantModule {}
