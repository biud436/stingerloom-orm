import { ExecutionContext, createParamDecorator } from "@nestjs/common";
import { AuthenticatedUser } from "./auth.types";

/**
 * `@CurrentUser()` resolves to `request.user` set by `JwtAuthGuard`.
 * Replaces the previous `@Headers('x-actor-user-id')` pattern, where any
 * caller could impersonate any user.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest();
    if (!req?.user) {
      throw new Error(
        "CurrentUser used on a route without authentication — mark @Public or apply JwtAuthGuard",
      );
    }
    return req.user as AuthenticatedUser;
  },
);

/** Resolves to the user id, the most common shape callers actually want. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number => {
    const req = ctx.switchToHttp().getRequest();
    if (!req?.user?.id) {
      throw new Error(
        "CurrentUserId used on a route without authentication — mark @Public or apply JwtAuthGuard",
      );
    }
    return req.user.id as number;
  },
);
