import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Inject,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { qAlias } from "@stingerloom/orm";
import { EntityManager } from "@stingerloom/orm";
import { Membership } from "../../modules/memberships/membership.entity";
import { RequestContextStore } from "../context/request-context";
import { Project } from "../../modules/projects/project.entity";
import { Issue } from "../../modules/issues/issue.entity";

export const WORKSPACE_PARAM = "workspace:param";
export const WORKSPACE_RESOLVE = "workspace:resolve";

/**
 * Strategy for locating the workspace id when only a child resource id is on
 * the URL. The example wires `issue` and `project`; extend as needed.
 */
export type WorkspaceResolver = "explicit" | "viaProject" | "viaIssue";

/**
 * Apply on a controller or handler to enforce that the authenticated user is
 * a member of the workspace the request targets. Rejects with 403 otherwise
 * and stamps `RequestContext.workspaceId` so services can scope queries to
 * one tenant without re-reading the path.
 *
 * @example
 *   @UseGuards(JwtAuthGuard, WorkspaceMemberGuard)
 *   @WorkspaceParam('workspaceId')
 *   class WorkspacesController {}
 */
@Injectable()
export class WorkspaceMemberGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(EntityManager) private readonly em: EntityManager,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const reqCtx = RequestContextStore.get();
    if (!reqCtx?.userId) {
      throw new ForbiddenException("Authentication required for workspace scope");
    }

    const resolver = this.reflector.getAllAndOverride<WorkspaceResolver>(
      WORKSPACE_RESOLVE,
      [ctx.getHandler(), ctx.getClass()],
    );

    const req = ctx.switchToHttp().getRequest();
    const workspaceId = await this.resolveWorkspaceId(req, resolver ?? "explicit", ctx);
    if (workspaceId === null) {
      // No workspaceId on the request and no resolver — let it through; the
      // handler clearly didn't intend to be workspace-scoped.
      return true;
    }

    const m = qAlias(Membership, "m");
    const membership = await this.em
      .createQueryBuilder(m)
      .where(m.workspaceId.eq(workspaceId))
      .andWhere(m.userId.eq(reqCtx.userId))
      .limit(1)
      .getOne();

    if (!membership) {
      throw new ForbiddenException(
        `User is not a member of workspace ${workspaceId}`,
      );
    }

    RequestContextStore.patch({ workspaceId });
    req.workspaceId = workspaceId;
    return true;
  }

  private async resolveWorkspaceId(
    req: Request & {
      params?: Record<string, string>;
      body?: Record<string, unknown>;
      query?: Record<string, unknown>;
    },
    resolver: WorkspaceResolver,
    ctx: ExecutionContext,
  ): Promise<number | null> {
    const paramName =
      this.reflector.getAllAndOverride<string>(WORKSPACE_PARAM, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? "workspaceId";

    const explicit =
      req.params?.[paramName] ??
      (req.body?.[paramName] as string | number | undefined) ??
      (req.query?.[paramName] as string | undefined);

    if (resolver === "explicit") {
      if (explicit === undefined || explicit === null || explicit === "") return null;
      const id = Number(explicit);
      if (!Number.isFinite(id)) return null;
      return id;
    }

    if (resolver === "viaProject") {
      const projectId = Number(
        req.params?.projectId ?? req.params?.id ?? req.body?.projectId,
      );
      if (!Number.isFinite(projectId)) return null;
      const p = qAlias(Project, "p");
      const row = await this.em
        .createQueryBuilder(p)
        .where(p.id.eq(projectId))
        .limit(1)
        .getOne();
      return row?.workspaceId ?? null;
    }

    if (resolver === "viaIssue") {
      const issueId = Number(req.params?.issueId ?? req.params?.id ?? req.body?.issueId);
      if (!Number.isFinite(issueId)) return null;
      const i = qAlias(Issue, "i");
      // Two-step lookup keeps the guard out of any join-builder edge cases
      // and reads from the issue.projectId FK + project.workspaceId path.
      const issue = await this.em
        .createQueryBuilder(i)
        .where(i.id.eq(issueId))
        .limit(1)
        .getOne();
      if (!issue?.projectId) return null;
      const p = qAlias(Project, "p");
      const project = await this.em
        .createQueryBuilder(p)
        .where(p.id.eq(issue.projectId))
        .limit(1)
        .getOne();
      return project?.workspaceId ?? null;
    }

    return null;
  }
}
