import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import { PUBLIC_ROUTE } from "./public.decorator";
import { JwtPayload } from "./auth.types";
import { RequestContextStore } from "../context/request-context";

/**
 * Verifies the `Authorization: Bearer <jwt>` header on every request unless
 * the handler is `@Public()`. On success, sets `request.user = { id }` and
 * patches the active `RequestContext` so downstream code (services, ORM
 * subscribers) can read the actor without prop drilling.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header = req.headers?.authorization as string | undefined;
    if (!header || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }
    const token = header.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException("Empty bearer token");
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
    if (typeof payload.sub !== "number") {
      throw new UnauthorizedException("Token missing subject");
    }

    req.user = { id: payload.sub };
    RequestContextStore.patch({ userId: payload.sub });
    return true;
  }
}
