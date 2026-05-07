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
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
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

/**
 * Find the most recent existing baseline file (if any) and extract the four
 * DDL arrays so a follow-up run with the *other* dialect can preserve them.
 *
 * Without this, two runs with different DB_TYPE values produce two different
 * baseline files, each populated for only one dialect — and the second run
 * leaves the file system with two competing baselines. Folding both dialects
 * into one file keeps the migration history single-rooted.
 */
function loadExistingArrays(): {
  mysqlUp: string[];
  mysqlDown: string[];
  pgUp: string[];
  pgDown: string[];
  filePath: string | null;
} {
  const empty = {
    mysqlUp: [] as string[],
    mysqlDown: [] as string[],
    pgUp: [] as string[],
    pgDown: [] as string[],
    filePath: null as string | null,
  };
  if (!existsSync(OUTPUT_DIR)) return empty;
  const files = readdirSync(OUTPUT_DIR)
    .filter((f) => /^\d+-baseline-schema\.ts$/.test(f))
    .sort();
  const latest = files[files.length - 1];
  if (!latest) return empty;
  const filePath = join(OUTPUT_DIR, latest);
  const text = readFileSync(filePath, "utf8");

  const extract = (name: string): string[] => {
    const re = new RegExp(
      `const\\s+${name}:\\s*string\\[\\]\\s*=\\s*\\[([\\s\\S]*?)\\];`,
    );
    const m = text.match(re);
    if (!m) return [];
    const body = m[1];
    const items: string[] = [];
    let i = 0;
    while (i < body.length) {
      while (i < body.length && body[i] !== "`") i++;
      if (i >= body.length) break;
      i++;
      let raw = "";
      while (i < body.length) {
        const ch = body[i];
        if (ch === "\\" && i + 1 < body.length) {
          const next = body[i + 1];
          if (next === "`") {
            raw += "`";
          } else if (next === "\\") {
            raw += "\\";
          } else if (next === "$") {
            raw += "$";
          } else {
            raw += ch + next;
          }
          i += 2;
          continue;
        }
        if (ch === "`") {
          i++;
          break;
        }
        raw += ch;
        i++;
      }
      items.push(raw);
    }
    return items;
  };

  return {
    mysqlUp: extract("MYSQL_UP"),
    mysqlDown: extract("MYSQL_DOWN"),
    pgUp: extract("POSTGRES_UP"),
    pgDown: extract("POSTGRES_DOWN"),
    filePath,
  };
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

  // Preserve the *other* dialect's arrays from the most recent baseline so
  // running this script twice (once per DB_TYPE) yields a single file with
  // both dialects populated. The previous baseline is unlinked at the end.
  const existing = loadExistingArrays();
  const mysqlUp = activeDialect === "mysql" ? activeUp : existing.mysqlUp;
  const mysqlDown = activeDialect === "mysql" ? activeDown : existing.mysqlDown;
  const pgUp = activeDialect === "postgres" ? activeUp : existing.pgUp;
  const pgDown = activeDialect === "postgres" ? activeDown : existing.pgDown;

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

  // Drop the previous baseline only after the new file is on disk and only if
  // it is a different file — re-running with the same timestamp would unlink
  // the file we just wrote.
  if (existing.filePath && existing.filePath !== filePath) {
    unlinkSync(existing.filePath);
  }

  // eslint-disable-next-line no-console
  console.log(`Wrote ${filePath}`);
  // eslint-disable-next-line no-console
  console.log(
    `Active dialect (${activeDialect}): ${activeUp.length} up / ${activeDown.length} down statements.`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Carried forward — MySQL: ${mysqlUp.length}/${mysqlDown.length}, Postgres: ${pgUp.length}/${pgDown.length}.`,
  );
  if (mysqlUp.length === 0 || pgUp.length === 0) {
    const missing = mysqlUp.length === 0 ? "mysql" : "postgres";
    // eslint-disable-next-line no-console
    console.log(
      `  ${missing.toUpperCase()} arrays still empty — re-run with DB_TYPE=${missing} to fill them in.`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `Next: import ${className} from "./migrations/${fileName.replace(/\.ts$/, "")}" and add \`new ${className}()\` to the migrations array in stingerloom.config.ts.`,
  );
}

main();
