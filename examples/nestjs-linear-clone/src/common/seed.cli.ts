import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import * as bcrypt from "bcryptjs";
import { AppModule } from "../app.module";
import { WorkspacesService } from "../modules/workspaces/workspaces.service";
import { UsersService } from "../modules/users/users.service";
import { MembershipsService } from "../modules/memberships/memberships.service";
import { ProjectsService } from "../modules/projects/projects.service";
import { SprintsService } from "../modules/sprints/sprints.service";
import { LabelsService } from "../modules/labels/labels.service";
import { IssuesService } from "../modules/issues/issues.service";
import { CommentsService } from "../modules/comments/comments.service";
import {
  MEMBERSHIP_ROLE,
  SPRINT_STATUS,
  ISSUE_STATUS,
  ISSUE_PRIORITY,
} from "./enums";
import { BaseRepository } from "@stingerloom/orm";
import { makeInjectRepositoryToken } from "@stingerloom/orm/nestjs";
import { User } from "../modules/users/user.entity";

const SEED_PASSWORD = "alice-bob-chris-dana";

/**
 * Populates a coherent dataset so analytics endpoints return non-empty data.
 * Idempotent: existing slugs/keys/emails are reused, conflicts are swallowed.
 *
 * Every seeded user has the same bcrypted password (`SEED_PASSWORD`) so the
 * test suite and curl examples can `POST /auth/login` to get a JWT.
 */
async function seed(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"],
  });

  const workspaces = app.get(WorkspacesService);
  const users = app.get(UsersService);
  const memberships = app.get(MembershipsService);
  const projects = app.get(ProjectsService);
  const sprints = app.get(SprintsService);
  const labels = app.get(LabelsService);
  const issues = app.get(IssuesService);
  const comments = app.get(CommentsService);
  const usersRepo = app.get<BaseRepository<User>>(makeInjectRepositoryToken(User));

  const safe = async <T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      return await fallback();
    }
  };

  const ws = await safe(
    () => workspaces.create({ name: "Acme Engineering", slug: "acme" }),
    () => workspaces.findBySlug("acme"),
  );

  const userInputs = [
    { email: "alice@acme.test", name: "Alice Park" },
    { email: "bob@acme.test", name: "Bob Lee" },
    { email: "chris@acme.test", name: "Chris Choi" },
    { email: "dana@acme.test", name: "Dana Kim" },
  ];

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  const userRows: User[] = [];
  for (const u of userInputs) {
    const created = await safe(
      () => users.create(u),
      async () => {
        const all = await users.findAll();
        return all.find((x) => x.email === u.email)!;
      },
    );
    if (!created.passwordHash) {
      created.passwordHash = passwordHash;
      await usersRepo.save(created);
    }
    userRows.push(created);
  }

  // First user is OWNER, rest MEMBER.
  for (let i = 0; i < userRows.length; i++) {
    const role = i === 0 ? MEMBERSHIP_ROLE.OWNER : MEMBERSHIP_ROLE.MEMBER;
    await safe(
      () =>
        memberships.invite({
          workspaceId: ws.id,
          userId: userRows[i].id,
          role,
        }),
      async () => {
        const list = await memberships.byWorkspace(ws.id);
        return list.find((m) => m.userId === userRows[i].id)!;
      },
    );
  }

  const project = await safe(
    () =>
      projects.create({
        workspaceId: ws.id,
        name: "Platform",
        key: "PLAT",
        description: "Platform reliability work",
        customFieldSchema: {
          fields: [
            { key: "severity", type: "enum", options: ["S0", "S1", "S2", "S3"] },
            { key: "customer", type: "string" },
          ],
        },
      }),
    async () => {
      const all = await projects.findAll(ws.id);
      return all.find((p) => p.key === "PLAT")!;
    },
  );

  const sprint = await sprints.create({
    projectId: project.id,
    name: `Sprint ${new Date().toISOString().slice(0, 10)}`,
    status: SPRINT_STATUS.ACTIVE,
    startDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10),
    endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10),
  });

  const labelRows = await Promise.all(
    ["bug", "regression", "perf", "ux"].map((name) =>
      safe(
        () => labels.create({ projectId: project.id, name }),
        async () => {
          const all = await labels.findAll(project.id);
          return all.find((l) => l.name === name)!;
        },
      ),
    ),
  );

  const titles = [
    "Login latency spike during deploys",
    "Race condition in token refresh",
    "OAuth callback drops state on retry",
    "Pagination cursor decoding edge case",
    "Migration runner deadlocks on tenant cutover",
    "Rate limiter leaking between tenants",
    "Background worker stuck in retry loop",
    "Snapshot replay reorders writes",
    "Dashboard chart rerenders too often",
    "Public API throws on empty Accept header",
  ];

  const created = [] as Array<{ id: number }>;
  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    const reporter = userRows[i % userRows.length];
    const assignee = i % 3 === 0 ? null : userRows[(i + 1) % userRows.length];

    const issue = await issues.create(
      {
        projectId: project.id,
        title,
        description: `Auto-seeded issue. Owner ${assignee?.name ?? "unassigned"}.`,
        status:
          i % 4 === 0
            ? ISSUE_STATUS.DONE
            : i % 3 === 0
              ? ISSUE_STATUS.IN_PROGRESS
              : i % 2 === 0
                ? ISSUE_STATUS.TODO
                : ISSUE_STATUS.BACKLOG,
        priority:
          i % 5 === 0
            ? ISSUE_PRIORITY.URGENT
            : i % 3 === 0
              ? ISSUE_PRIORITY.HIGH
              : ISSUE_PRIORITY.MEDIUM,
        estimate: 1 + (i % 5),
        sprintId: i < 5 ? sprint.id : undefined,
        assigneeId: assignee?.id,
        customFields:
          i % 2 === 0
            ? { severity: i % 3 === 0 ? "S0" : "S2", customer: "BigCorp" }
            : { severity: "S3", customer: "AcmeRetail" },
      },
      reporter.id,
    );
    created.push(issue);

    if (i < 4) {
      await comments.create(
        {
          issueId: issue.id,
          body: `First triage notes for "${title}". Looks reproducible on staging.`,
        },
        reporter.id,
      );
    }

    if (i % 3 === 0 && i > 0) {
      await issues.addLabel(
        issue.id,
        { labelId: labelRows[i % labelRows.length].id },
        reporter.id,
      );
    }
  }

  // Build a small subissue tree under the first issue
  const root = created[0];
  const subA = await issues.create(
    {
      projectId: project.id,
      title: "Investigate connection pool sizing",
      parentId: root.id,
      status: ISSUE_STATUS.IN_PROGRESS,
      priority: ISSUE_PRIORITY.HIGH,
      estimate: 3,
    },
    userRows[0].id,
  );
  const subB = await issues.create(
    {
      projectId: project.id,
      title: "Add circuit breaker to auth service",
      parentId: root.id,
      status: ISSUE_STATUS.TODO,
      priority: ISSUE_PRIORITY.MEDIUM,
      estimate: 5,
    },
    userRows[1].id,
  );
  await issues.create(
    {
      projectId: project.id,
      title: "Tune connection idle-timeout in pool",
      parentId: subA.id,
      status: ISSUE_STATUS.TODO,
      priority: ISSUE_PRIORITY.LOW,
      estimate: 2,
    },
    userRows[2].id,
  );
  await issues.create(
    {
      projectId: project.id,
      title: "Add metrics for circuit breaker trips",
      parentId: subB.id,
      status: ISSUE_STATUS.BACKLOG,
      priority: ISSUE_PRIORITY.LOW,
      estimate: 2,
    },
    userRows[3].id,
  );

  // eslint-disable-next-line no-console
  console.log(
    "Seed complete. Workspace=%d Project=%d Issues=%d. Login: %s / %s",
    ws.id,
    project.id,
    created.length + 4,
    userRows[0].email,
    SEED_PASSWORD,
  );
  await app.close();
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
