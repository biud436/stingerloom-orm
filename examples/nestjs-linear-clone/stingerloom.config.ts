/* eslint-disable @typescript-eslint/no-var-requires */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { SnakeNamingStrategy } from "@stingerloom/orm";

import { Workspace } from "./src/modules/workspaces/workspace.entity";
import { User } from "./src/modules/users/user.entity";
import { Membership } from "./src/modules/memberships/membership.entity";
import { Project } from "./src/modules/projects/project.entity";
import { Sprint } from "./src/modules/sprints/sprint.entity";
import { Issue } from "./src/modules/issues/issue.entity";
import { Label } from "./src/modules/labels/label.entity";
import { Comment } from "./src/modules/comments/comment.entity";
import { CommentRevision } from "./src/modules/comments/comment-revision.entity";
import { Reaction } from "./src/modules/comments/reaction.entity";
import { ActivityLog } from "./src/modules/activity/activity-log.entity";
import { IssueLink } from "./src/modules/links/link.entity";
import { SavedFilter } from "./src/modules/saved-filters/saved-filter.entity";
import { WorkflowDefinition } from "./src/modules/workflows/workflow-definition.entity";
import { WorkflowTransition } from "./src/modules/workflows/workflow-transition.entity";
import { IssueWatcher } from "./src/modules/notifications/issue-watcher.entity";
import { Notification } from "./src/modules/notifications/notification.entity";
import { WebhookEndpoint } from "./src/modules/webhooks/webhook-endpoint.entity";
import { WebhookDelivery } from "./src/modules/webhooks/webhook-delivery.entity";
import { BulkOperation } from "./src/modules/bulk-operations/bulk-operation.entity";
import { IdempotencyKey } from "./src/common/idempotency/idempotency-key.entity";
import { BaselineSchema_20260507133946 } from "./migrations/20260507133946-baseline-schema";

// Load .env so DB_* match the running app. .env.local wins when present.
loadEnv({ path: resolve(__dirname, ".env.local") });
loadEnv({ path: resolve(__dirname, ".env") });

const dbType = (process.env.DB_TYPE ?? "mysql") as "mysql" | "postgres";

/**
 * Migration CLI config — consumed by `npx stingerloom migrate:*`.
 *
 * The CLI auto-loads this file (it sits at the project root with one of the
 * recognized names: `stingerloom.config.ts`). `database` is the same
 * DatabaseClientOptions block AppModule passes to `StingerloomOrmModule`,
 * but with `synchronize: false` because migrations own DDL once a project
 * has them — letting both run produces drift.
 */
const config = {
  database: {
    type: dbType,
    host: process.env.DB_HOST ?? "localhost",
    port: process.env.DB_PORT
      ? Number(process.env.DB_PORT)
      : dbType === "postgres"
        ? 5432
        : 3306,
    username: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "password",
    database: process.env.DB_NAME ?? "linear_clone",
    entities: [
      Workspace,
      User,
      Membership,
      Project,
      Sprint,
      Issue,
      Label,
      Comment,
      CommentRevision,
      Reaction,
      ActivityLog,
      IssueLink,
      SavedFilter,
      WorkflowDefinition,
      WorkflowTransition,
      IssueWatcher,
      Notification,
      WebhookEndpoint,
      WebhookDelivery,
      BulkOperation,
      IdempotencyKey,
    ],
    // Mirror app.module.ts so generated migrations match runtime DDL.
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  },
  // Migrations apply in array order. The frozen baseline below was emitted
  // by `pnpm migrate:baseline` and locks the schema-as-of-generation in.
  // For incremental changes after the baseline:
  //   1. Edit entities under src/.
  //   2. Run `pnpm migrate:generate` against a DB at the prior migration's state.
  //   3. Append the new migration class to this array.
  migrations: [new BaselineSchema_20260507133946()],
};

export default config;
