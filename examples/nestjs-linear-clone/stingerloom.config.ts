/* eslint-disable @typescript-eslint/no-var-requires */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

import { Workspace } from "./src/modules/workspaces/workspace.entity";
import { User } from "./src/modules/users/user.entity";
import { Membership } from "./src/modules/memberships/membership.entity";
import { Project } from "./src/modules/projects/project.entity";
import { Sprint } from "./src/modules/sprints/sprint.entity";
import { Issue } from "./src/modules/issues/issue.entity";
import { Label } from "./src/modules/labels/label.entity";
import { Comment } from "./src/modules/comments/comment.entity";
import { ActivityLog } from "./src/modules/activity/activity-log.entity";

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
      ActivityLog,
    ],
    synchronize: false,
  },
  // Migration class array is empty until you run `pnpm migrate:generate`.
  // Each generated file exports a Migration; import & list it here:
  //   import { CreateInitialSchema_001 } from "./migrations/001-create-initial-schema";
  //   migrations: [new CreateInitialSchema_001()],
  migrations: [] as Array<unknown>,
};

export default config;
