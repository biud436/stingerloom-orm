/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Generate a frozen baseline migration from current entity definitions —
 * no DB connection required.
 *
 * Why a custom script instead of `pnpm migrate:generate`?
 *   `migrate:generate` diffs entities against a live DB. For the very first
 *   migration there is no DB schema to diff against, and we do not want to
 *   force every contributor to spin up MySQL just to capture the baseline.
 *
 * What it does:
 *   1. Loads every entity referenced from `stingerloom.config.ts`.
 *   2. Applies SnakeNamingStrategy through the public
 *      `EntityManager.applyNamingStrategyToEntities` helper so column / table
 *      names match what the runtime EntityManager produces.
 *   3. Walks the entity graph through `SchemaGenerator` for both MySQL and
 *      Postgres dialects and emits the resulting DDL strings into a
 *      `migrations/<timestamp>-baseline-schema.ts` file.
 *   4. The generated file is a frozen `Migration` subclass — its `up()` /
 *      `down()` arrays do *not* re-read entity metadata at run time, so the
 *      baseline cannot drift even when entities later change.
 *
 * After running this once, subsequent edits flow through
 * `pnpm migrate:generate` (which diffs against the live DB).
 */
import "reflect-metadata";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { config as loadEnv } from "dotenv";
import {
  EntityManager,
  SchemaGenerator,
  SnakeNamingStrategy,
} from "@stingerloom/orm";

loadEnv({ path: resolve(__dirname, "..", ".env.local") });
loadEnv({ path: resolve(__dirname, "..", ".env") });

// The script imports entities directly rather than going through
// stingerloom.config — that file pulls in already-generated baseline
// migrations, which would create a circular dependency when regenerating.
import { Workspace } from "../src/modules/workspaces/workspace.entity";
import { User } from "../src/modules/users/user.entity";
import { Membership } from "../src/modules/memberships/membership.entity";
import { Project } from "../src/modules/projects/project.entity";
import { Sprint } from "../src/modules/sprints/sprint.entity";
import { Issue } from "../src/modules/issues/issue.entity";
import { Label } from "../src/modules/labels/label.entity";
import { Comment } from "../src/modules/comments/comment.entity";
import { CommentRevision } from "../src/modules/comments/comment-revision.entity";
import { Reaction } from "../src/modules/comments/reaction.entity";
import { ActivityLog } from "../src/modules/activity/activity-log.entity";
import { IssueLink } from "../src/modules/links/link.entity";
import { SavedFilter } from "../src/modules/saved-filters/saved-filter.entity";
import { WorkflowDefinition } from "../src/modules/workflows/workflow-definition.entity";
import { WorkflowTransition } from "../src/modules/workflows/workflow-transition.entity";
import { IssueWatcher } from "../src/modules/notifications/issue-watcher.entity";
import { Notification } from "../src/modules/notifications/notification.entity";
import { WebhookEndpoint } from "../src/modules/webhooks/webhook-endpoint.entity";
import { WebhookDelivery } from "../src/modules/webhooks/webhook-delivery.entity";
import { BulkOperation } from "../src/modules/bulk-operations/bulk-operation.entity";
import { IdempotencyKey } from "../src/common/idempotency/idempotency-key.entity";

const ENTITIES = [
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
];

const OUTPUT_DIR = resolve(__dirname, "..", "migrations");
const TIMESTAMP = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+/, "")
  .replace("T", "");

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function ddlArray(ddls: string[]): string {
  return ddls.map((d) => `      \`${escape(d)}\``).join(",\n");
}

function main(): void {
  const entities = ENTITIES as Array<new () => unknown>;

  EntityManager.applyNamingStrategyToEntities(
    entities,
    new SnakeNamingStrategy(),
  );

  // The entity's @ComputedColumn expression for `cycleTimeHours` is selected
  // at decoration time from `process.env.DB_TYPE`. We honour that by emitting
  // DDL for the *active* dialect only; the other dialect's array stays empty
  // until you re-run the script with the matching DB_TYPE.
  const activeDialect = (process.env.DB_TYPE ?? "mysql") as "mysql" | "postgres";

  const sg = new SchemaGenerator({
    dialect: activeDialect,
    namingStrategy: new SnakeNamingStrategy(),
  });

  const activeUp = sg.generateSchemaDDL(entities);
  const activeDown = sg.generateDropSchemaDDL(entities);

  const mysqlUp = activeDialect === "mysql" ? activeUp : [];
  const mysqlDown = activeDialect === "mysql" ? activeDown : [];
  const pgUp = activeDialect === "postgres" ? activeUp : [];
  const pgDown = activeDialect === "postgres" ? activeDown : [];

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const className = `BaselineSchema_${TIMESTAMP}`;
  const fileName = `${TIMESTAMP}-baseline-schema.ts`;
  const filePath = join(OUTPUT_DIR, fileName);

  const body = `/**
 * Auto-generated by scripts/generate-baseline.ts on ${new Date().toISOString()}.
 *
 * Frozen baseline: the DDL arrays below are the literal schema as of
 * generation. Re-running the script overwrites this file. Once it is
 * checked in, edit the generator instead of the file by hand.
 *
 * Apply with: pnpm migrate:run
 * Roll back with: pnpm migrate:rollback
 */
import { Migration, MigrationContext } from "@stingerloom/orm";

const MYSQL_UP: string[] = [
${ddlArray(mysqlUp)}
];

const MYSQL_DOWN: string[] = [
${ddlArray(mysqlDown)}
];

const POSTGRES_UP: string[] = [
${ddlArray(pgUp)}
];

const POSTGRES_DOWN: string[] = [
${ddlArray(pgDown)}
];

export class ${className} extends Migration {
  async up(ctx: MigrationContext): Promise<void> {
    const ddls = ctx.driver.isMySqlFamily() ? MYSQL_UP : POSTGRES_UP;
    for (const ddl of ddls) {
      await ctx.query(ddl);
    }
  }

  async down(ctx: MigrationContext): Promise<void> {
    const ddls = ctx.driver.isMySqlFamily() ? MYSQL_DOWN : POSTGRES_DOWN;
    for (const ddl of ddls) {
      await ctx.query(ddl);
    }
  }
}
`;

  writeFileSync(filePath, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${filePath}`);
  // eslint-disable-next-line no-console
  console.log(
    `Active dialect (${activeDialect}): ${activeUp.length} up / ${activeDown.length} down statements.`,
  );
  if (activeDialect === "mysql") {
    // eslint-disable-next-line no-console
    console.log(
      "  Postgres arrays are empty. Re-run with DB_TYPE=postgres to fill them in if you target both dialects.",
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "  MySQL arrays are empty. Re-run with DB_TYPE=mysql to fill them in if you target both dialects.",
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `Next: import ${className} from "./migrations/${fileName.replace(/\.ts$/, "")}" and add \`new ${className}()\` to the migrations array in stingerloom.config.ts.`,
  );
}

main();
