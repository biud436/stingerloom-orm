import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { UsersService } from "../users/users.service";
import { MembershipsService } from "../memberships/memberships.service";
import { ProjectsService } from "../projects/projects.service";
import { SprintsService } from "../sprints/sprints.service";
import { LabelsService } from "../labels/labels.service";
import { IssuesService } from "../issues/issues.service";
import { CommentsService } from "../comments/comments.service";
import {
  MEMBERSHIP_ROLE,
  SPRINT_STATUS,
  ISSUE_STATUS,
  ISSUE_PRIORITY,
} from "./enums";

/**
 * Populates a coherent dataset so analytics endpoints return non-empty data.
 * Idempotent: existing slugs/keys/emails are reused, conflicts are swallowed.
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
  const userRows = await Promise.all(
    userInputs.map(async (u) =>
      safe(
        () => users.create(u),
        async () => {
          const all = await users.findAll();
          return all.find((x) => x.email === u.email)!;
        },
      ),
    ),
  );

  for (const u of userRows) {
    await safe(
      () =>
        memberships.invite({
          workspaceId: ws.id,
          userId: u.id,
          role: MEMBERSHIP_ROLE.MEMBER,
        }),
      async () => {
        const list = await memberships.byWorkspace(ws.id);
        return list.find((m) => m.userId === u.id)!;
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

  // Seed root-level issues, then a couple of subissues for the recursive tree demo.
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

    const issue = await issues.create({
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
      reporterId: reporter.id,
      customFields:
        i % 2 === 0
          ? { severity: i % 3 === 0 ? "S0" : "S2", customer: "BigCorp" }
          : { severity: "S3", customer: "AcmeRetail" },
    });
    created.push(issue);

    if (i < 4) {
      await comments.create({
        issueId: issue.id,
        authorId: reporter.id,
        body: `First triage notes for "${title}". Looks reproducible on staging.`,
      });
    }

    if (i % 3 === 0 && i > 0) {
      await issues.addLabel(issue.id, { labelId: labelRows[i % labelRows.length].id });
    }
  }

  // Build a small subissue tree under the first issue
  const root = created[0];
  const subA = await issues.create({
    projectId: project.id,
    title: "Investigate connection pool sizing",
    parentId: root.id,
    status: ISSUE_STATUS.IN_PROGRESS,
    priority: ISSUE_PRIORITY.HIGH,
    estimate: 3,
    reporterId: userRows[0].id,
  });
  const subB = await issues.create({
    projectId: project.id,
    title: "Add circuit breaker to auth service",
    parentId: root.id,
    status: ISSUE_STATUS.TODO,
    priority: ISSUE_PRIORITY.MEDIUM,
    estimate: 5,
    reporterId: userRows[1].id,
  });
  await issues.create({
    projectId: project.id,
    title: "Tune connection idle-timeout in pool",
    parentId: subA.id,
    status: ISSUE_STATUS.TODO,
    priority: ISSUE_PRIORITY.LOW,
    estimate: 2,
    reporterId: userRows[2].id,
  });
  await issues.create({
    projectId: project.id,
    title: "Add metrics for circuit breaker trips",
    parentId: subB.id,
    status: ISSUE_STATUS.BACKLOG,
    priority: ISSUE_PRIORITY.LOW,
    estimate: 2,
    reporterId: userRows[3].id,
  });

  console.log("Seed complete. Workspace=%d, Project=%d, Issues=%d", ws.id, project.id, created.length + 4);
  await app.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
