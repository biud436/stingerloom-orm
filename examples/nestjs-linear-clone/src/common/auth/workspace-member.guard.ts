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
import { Sprint } from "../../modules/sprints/sprint.entity";
import { Label } from "../../modules/labels/label.entity";

export const WORKSPACE_PARAM = "workspace:param";
export const WORKSPACE_RESOLVE = "workspace:resolve";

/**
 * Strategy for locating the workspace id when only a child resource id is on
 * the URL. The example wires `issue`, `project`, `sprint`, and `label`; extend
 * as needed by adding a branch to {@link WorkspaceMemberGuard.resolveWorkspaceId}.
 */
export type WorkspaceResolver =
  | "explicit"
  | "viaProject"
  | "viaIssue"
  | "viaSprint"
  | "viaLabel";

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
    const resolved = await this.resolveWorkspaceId(req, resolver ?? "explicit", ctx);

    if (resolved === "no-identifier") {
      // The handler opted into workspace scoping (the decorator wired this
      // guard) but the request didn't carry the identifier needed to resolve
      // a workspace — e.g. `GET /projects` with no ?workspaceId. Fail closed:
      // silently letting through was the original cross-tenant leak (#335).
      throw new ForbiddenException(
        "Workspace cannot be resolved for this request",
      );
    }

    if (resolved === "resource-missing") {
      // The identifier was structurally valid but no such row exists. Let
      // the handler run so it returns the canonical 404 (or whatever it
      // chooses to do); the guard has nothing to enforce against a row
      // that doesn't exist, and surfacing 403 here would mask 404 and
      // make legitimate "not found" probes hard to debug.
      return true;
    }

    const workspaceId = resolved;
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
  ): Promise<number | "no-identifier" | "resource-missing"> {
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
      if (explicit === undefined || explicit === null || explicit === "") {
        return "no-identifier";
      }
      const id = Number(explicit);
      if (!Number.isFinite(id)) return "no-identifier";
      return id;
    }

    if (resolver === "viaProject") {
      // Accept the projectId from any of: a dedicated :projectId path param,
      // a generic :id (the projects detail routes), the request body
      // (creation flows), or the query string (filtered list endpoints).
      const raw =
        req.params?.projectId ??
        req.params?.id ??
        req.body?.projectId ??
        req.query?.projectId;
      const projectId = Number(raw);
      if (raw === undefined || !Number.isFinite(projectId)) return "no-identifier";
      const ws = await this.workspaceOfProject(projectId);
      return ws ?? "resource-missing";
    }

    if (resolver === "viaIssue") {
      const raw = req.params?.issueId ?? req.params?.id ?? req.body?.issueId;
      const issueId = Number(raw);
      if (raw === undefined || !Number.isFinite(issueId)) return "no-identifier";
      const i = qAlias(Issue, "i");
      // Two-step lookup keeps the guard out of any join-builder edge cases
      // and reads from the issue.projectId FK + project.workspaceId path.
      // `withDeleted()` is intentional: a soft-deleted issue still belongs
      // to its workspace, so the guard resolves correctly for the restore
      // endpoint and for GET-after-soft-delete (which 404s in the handler).
      const issue = await this.em
        .createQueryBuilder(i)
        .withDeleted()
        .where(i.id.eq(issueId))
        .limit(1)
        .getOne();
      if (!issue?.projectId) return "resource-missing";
      const ws = await this.workspaceOfProject(issue.projectId);
      return ws ?? "resource-missing";
    }

    if (resolver === "viaSprint") {
      const raw = req.params?.sprintId ?? req.params?.id;
      const sprintId = Number(raw);
      if (raw === undefined || !Number.isFinite(sprintId)) return "no-identifier";
      const s = qAlias(Sprint, "s");
      const sprint = await this.em
        .createQueryBuilder(s)
        .where(s.id.eq(sprintId))
        .limit(1)
        .getOne();
      if (!sprint?.projectId) return "resource-missing";
      const ws = await this.workspaceOfProject(sprint.projectId);
      return ws ?? "resource-missing";
    }

    if (resolver === "viaLabel") {
      const raw = req.params?.labelId ?? req.params?.id;
      const labelId = Number(raw);
      if (raw === undefined || !Number.isFinite(labelId)) return "no-identifier";
      const l = qAlias(Label, "l");
      const label = await this.em
        .createQueryBuilder(l)
        .where(l.id.eq(labelId))
        .limit(1)
        .getOne();
      if (!label?.projectId) return "resource-missing";
      const ws = await this.workspaceOfProject(label.projectId);
      return ws ?? "resource-missing";
    }

    return "no-identifier";
  }

  private async workspaceOfProject(projectId: number): Promise<number | null> {
    const p = qAlias(Project, "p");
    const row = await this.em
      .createQueryBuilder(p)
      .where(p.id.eq(projectId))
      .limit(1)
      .getOne();
    return row?.workspaceId ?? null;
  }
}
