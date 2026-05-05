/**
 * Shape of the JWT payload issued by `AuthService.issueToken`. Kept stable
 * because the same shape must be honored by guards across boots.
 */
export interface JwtPayload {
  /** Subject — the authenticated user id. */
  sub: number;
  /** Issued-at, seconds since epoch. */
  iat?: number;
  /** Expiry, seconds since epoch. */
  exp?: number;
}

/**
 * Reflects the authenticated principal. Resolved into `request.user` by
 * `JwtAuthGuard`. Workspace scope is *not* on this object — that lives on
 * `RequestContext.workspaceId`, populated by `WorkspaceMemberGuard`, so the
 * auth and authz layers stay independently testable.
 */
export interface AuthenticatedUser {
  id: number;
}
