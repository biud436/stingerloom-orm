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
import { Comment } from "../../modules/comments/comment.entity";
import { WorkLog } from "../../modules/work-logs/work-log.entity";
import { WebhookEndpoint } from "../../modules/webhooks/webhook-endpoint.entity";
import { WebhookDelivery } from "../../modules/webhooks/webhook-delivery.entity";
import {
  Attachment,
  ATTACHMENT_OWNER,
} from "../../modules/attachments/attachment.entity";
import { SavedFilter } from "../../modules/saved-filters/saved-filter.entity";

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
  | "viaLabel"
  | "viaComment"
  | "viaWorkLog"
  | "viaMembership"
  | "viaWebhookEndpoint"
  | "viaWebhookDelivery"
  | "viaAttachment"
  | "viaSavedFilter";

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
      return this.workspaceOfIssue(issueId);
    }

    if (resolver === "viaComment") {
      // Two shapes share this resolver:
      //   /comments/:id/...        → comment row → its issue → workspace
      //   POST /comments, GET /comments[/cursor]?issueId= → issueId in
      //                              body/query → issue → workspace
      const commentIdRaw = req.params?.id;
      if (commentIdRaw !== undefined) {
        const commentId = Number(commentIdRaw);
        if (!Number.isFinite(commentId)) return "no-identifier";
        const c = qAlias(Comment, "c");
        // withDeleted: a soft-removed comment still belongs to its workspace,
        // so revisions/thread on a trashed comment resolve correctly.
        const comment = await this.em
          .createQueryBuilder(c)
          .withDeleted()
          .where(c.id.eq(commentId))
          .limit(1)
          .getOne();
        if (!comment?.issueId) return "resource-missing";
        return this.workspaceOfIssue(comment.issueId);
      }
      const raw = req.body?.issueId ?? req.query?.issueId;
      const issueId = Number(raw);
      if (raw === undefined || !Number.isFinite(issueId)) return "no-identifier";
      return this.workspaceOfIssue(issueId);
    }

    if (resolver === "viaWorkLog") {
      const raw = req.params?.id;
      const workLogId = Number(raw);
      if (raw === undefined || !Number.isFinite(workLogId)) return "no-identifier";
      const w = qAlias(WorkLog, "w");
      const log = await this.em
        .createQueryBuilder(w)
        .where(w.id.eq(workLogId))
        .limit(1)
        .getOne();
      if (!log?.issueId) return "resource-missing";
      return this.workspaceOfIssue(log.issueId);
    }

    if (resolver === "viaMembership") {
      const raw = req.params?.id;
      const membershipId = Number(raw);
      if (raw === undefined || !Number.isFinite(membershipId)) {
        return "no-identifier";
      }
      const m = qAlias(Membership, "m");
      const row = await this.em
        .createQueryBuilder(m)
        .where(m.id.eq(membershipId))
        .limit(1)
        .getOne();
      if (row?.workspaceId == null) return "resource-missing";
      return row.workspaceId;
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

    if (resolver === "viaWebhookEndpoint") {
      // /webhooks/endpoints/:id → endpoint row → its workspace.
      const raw = req.params?.id;
      const endpointId = Number(raw);
      if (raw === undefined || !Number.isFinite(endpointId)) {
        return "no-identifier";
      }
      const ws = await this.workspaceOfWebhookEndpoint(endpointId);
      return ws ?? "resource-missing";
    }

    if (resolver === "viaWebhookDelivery") {
      // /webhooks/deliveries/:id/... → delivery → endpoint → workspace.
      const raw = req.params?.id;
      const deliveryId = Number(raw);
      if (raw === undefined || !Number.isFinite(deliveryId)) {
        return "no-identifier";
      }
      const d = qAlias(WebhookDelivery, "d");
      const delivery = await this.em
        .createQueryBuilder(d)
        .where(d.id.eq(deliveryId))
        .limit(1)
        .getOne();
      if (delivery?.endpointId == null) return "resource-missing";
      const ws = await this.workspaceOfWebhookEndpoint(delivery.endpointId);
      return ws ?? "resource-missing";
    }

    if (resolver === "viaAttachment") {
      // /attachments/:id → polymorphic owner (issue|comment) → workspace.
      const raw = req.params?.id;
      const attachmentId = Number(raw);
      if (raw === undefined || !Number.isFinite(attachmentId)) {
        return "no-identifier";
      }
      const a = qAlias(Attachment, "a");
      const att = await this.em
        .createQueryBuilder(a)
        .where(a.id.eq(attachmentId))
        .limit(1)
        .getOne();
      if (!att) return "resource-missing";
      if (att.ownerType === ATTACHMENT_OWNER.ISSUE) {
        return this.workspaceOfIssue(att.ownerId);
      }
      if (att.ownerType === ATTACHMENT_OWNER.COMMENT) {
        const c = qAlias(Comment, "c");
        const comment = await this.em
          .createQueryBuilder(c)
          .withDeleted()
          .where(c.id.eq(att.ownerId))
          .limit(1)
          .getOne();
        if (!comment?.issueId) return "resource-missing";
        return this.workspaceOfIssue(comment.issueId);
      }
      return "resource-missing";
    }

    if (resolver === "viaSavedFilter") {
      // /saved-filters/:id/... → saved filter row → its workspace.
      const raw = req.params?.id;
      const filterId = Number(raw);
      if (raw === undefined || !Number.isFinite(filterId)) {
        return "no-identifier";
      }
      const f = qAlias(SavedFilter, "f");
      const filter = await this.em
        .createQueryBuilder(f)
        .where(f.id.eq(filterId))
        .limit(1)
        .getOne();
      if (filter?.workspaceId == null) return "resource-missing";
      return filter.workspaceId;
    }

    return "no-identifier";
  }

  private async workspaceOfWebhookEndpoint(
    endpointId: number,
  ): Promise<number | null> {
    const e = qAlias(WebhookEndpoint, "e");
    const ep = await this.em
      .createQueryBuilder(e)
      .where(e.id.eq(endpointId))
      .limit(1)
      .getOne();
    return ep?.workspaceId ?? null;
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

  /**
   * Resolve the workspace an issue belongs to via its project. `withDeleted()`
   * is intentional: a soft-deleted issue still belongs to its workspace, so the
   * guard resolves correctly for restore / GET-after-soft-delete (which 404s in
   * the handler). Returns `"resource-missing"` when the issue or its project is
   * gone so the caller can let the handler emit the canonical 404.
   */
  private async workspaceOfIssue(
    issueId: number,
  ): Promise<number | "resource-missing"> {
    const i = qAlias(Issue, "i");
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
}
