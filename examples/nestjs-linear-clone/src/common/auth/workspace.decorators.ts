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
 */
export function WorkspaceScoped(opts: {
  from: "param" | "body" | "query" | "project" | "issue";
  name?: string;
}) {
  const resolver: WorkspaceResolver =
    opts.from === "project"
      ? "viaProject"
      : opts.from === "issue"
        ? "viaIssue"
        : "explicit";
  const decorators = [
    UseGuards(JwtAuthGuard, WorkspaceMemberGuard),
    SetMetadata(WORKSPACE_RESOLVE, resolver),
  ];
  if (opts.name) {
    decorators.push(SetMetadata(WORKSPACE_PARAM, opts.name));
  }
  return applyDecorators(...decorators);
}
