import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { MetadataContext } from "@stingerloom/orm";
import { RequestContextStore } from "../context/request-context";

/**
 * Opens a Stingerloom `MetadataContext.run(tenantId, …)` AsyncLocalStorage
 * frame for the duration of the request handler so that the ORM's layered
 * metadata system, EntitySubscribers, and any tenant-aware code paths see
 * the current workspace as the active tenant.
 *
 * Ordering: this interceptor MUST run AFTER `JwtAuthGuard` (so `userId` is
 * known) and AFTER `WorkspaceMemberGuard` (so `workspaceId` has been
 * resolved + verified). Within the global interceptor chain it must be the
 * LAST one registered — the last interceptor's `next.handle()` is what
 * actually invokes the controller, so registering here ensures every
 * downstream service / repository / subscriber call sees the frame.
 *
 * Routes that have no workspace (auth, healthz, public endpoints) simply
 * pass through unchanged: there is no tenant to scope to, and forcing a
 * frame would mask the "outside any tenant" case the ORM intentionally
 * surfaces as `"public"`.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const workspaceId = RequestContextStore.get()?.workspaceId;
    if (workspaceId === null || workspaceId === undefined) {
      return next.handle();
    }

    // `MetadataContext.run` opens an AsyncLocalStorage frame that stays
    // valid for every promise / microtask queued from inside the callback.
    // Subscribing to `next.handle()` inside the run() callback anchors the
    // controller's async work to this frame, so every later `await` keeps
    // seeing the same tenant.
    return new Observable((observer) => {
      MetadataContext.run(String(workspaceId), () => {
        next.handle().subscribe({
          next: (value) => observer.next(value),
          error: (err) => observer.error(err),
          complete: () => observer.complete(),
        });
      });
    });
  }
}
