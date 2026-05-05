import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request execution context. Lives in `AsyncLocalStorage` so any service
 * (or ORM subscriber) can read the caller's identity without threading it
 * through every method signature. Populated by `RequestContextMiddleware`
 * + `JwtAuthGuard` + `WorkspaceMemberGuard`.
 */
export interface RequestContext {
  /** Correlation id propagated to logs and downstream services. */
  requestId: string;
  /** Authenticated user id. `null` for anonymous routes (`@Public`). */
  userId: number | null;
  /**
   * Workspace the request is scoped to. Set by `WorkspaceMemberGuard` once
   * it has resolved a path/body/query `workspaceId` and verified membership.
   * `null` for routes that don't carry a workspace.
   */
  workspaceId: number | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContextStore = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },

  /** Returns `null` when called outside a request (e.g. CLI / seed). */
  get(): RequestContext | null {
    return storage.getStore() ?? null;
  },

  /** Throws if called outside a request — use when the context is required. */
  require(): RequestContext {
    const ctx = storage.getStore();
    if (!ctx) {
      throw new Error(
        "RequestContext is not available — caller must be inside an HTTP request",
      );
    }
    return ctx;
  },

  /** Mutate the active context (used by guards as they progressively resolve). */
  patch(patch: Partial<RequestContext>): void {
    const ctx = storage.getStore();
    if (!ctx) return;
    Object.assign(ctx, patch);
  },
};
