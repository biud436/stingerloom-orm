import { SetMetadata, applyDecorators, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "./jwt-auth.guard";
import {
  WorkspaceMemberGuard,
  WorkspaceResolver,
  WORKSPACE_PARAM,
  WORKSPACE_RESOLVE,
} from "./workspace-member.guard";

/**
 * Bind a controller/handler to a workspace. Combines `JwtAuthGuard` (must be
 * authenticated) and `WorkspaceMemberGuard` (must be a member of the resolved
 * workspace).
 *
 * @example
 *   // /workspaces/:workspaceId/...  → reads `workspaceId` from path
 *   @WorkspaceScoped({ from: 'param', name: 'workspaceId' })
 *
 *   // /projects/:id/...  → looks up the project's workspace
 *   @WorkspaceScoped({ from: 'project' })
 *
 *   // /issues/:id/...  → looks up the issue's project's workspace
 *   @WorkspaceScoped({ from: 'issue' })
 *
 *   // /sprints/:id/...  → looks up the sprint's project's workspace
 *   @WorkspaceScoped({ from: 'sprint' })
 *
 *   // /labels/:id/...  → looks up the label's project's workspace
 *   @WorkspaceScoped({ from: 'label' })
 *
 *   // /comments/:id/... or ?issueId= → comment → issue → workspace
 *   @WorkspaceScoped({ from: 'comment' })
 *
 *   // /work-logs/:id/...  → work log → issue → workspace
 *   @WorkspaceScoped({ from: 'workLog' })
 *
 *   // /memberships/:id/...  → reads the membership row's workspace
 *   @WorkspaceScoped({ from: 'membership' })
 */
export function WorkspaceScoped(opts: {
  from:
    | "param"
    | "body"
    | "query"
    | "project"
    | "issue"
    | "sprint"
    | "label"
    | "comment"
    | "workLog"
    | "membership"
    | "webhookEndpoint"
    | "webhookDelivery"
    | "attachment"
    | "savedFilter";
  name?: string;
}) {
  const resolverByFrom: Record<string, WorkspaceResolver> = {
    project: "viaProject",
    issue: "viaIssue",
    sprint: "viaSprint",
    label: "viaLabel",
    comment: "viaComment",
    workLog: "viaWorkLog",
    membership: "viaMembership",
    webhookEndpoint: "viaWebhookEndpoint",
    webhookDelivery: "viaWebhookDelivery",
    attachment: "viaAttachment",
    savedFilter: "viaSavedFilter",
  };
  const resolver: WorkspaceResolver = resolverByFrom[opts.from] ?? "explicit";
  const decorators = [
    UseGuards(JwtAuthGuard, WorkspaceMemberGuard),
    SetMetadata(WORKSPACE_RESOLVE, resolver),
  ];
  if (opts.name) {
    decorators.push(SetMetadata(WORKSPACE_PARAM, opts.name));
  }
  return applyDecorators(...decorators);
}
