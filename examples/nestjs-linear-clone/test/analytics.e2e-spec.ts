import * as request from "supertest";
import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  BootedApp,
} from "./helpers/test-app";
import {
  createBaseFixture,
  createSprint,
  createIssue,
  BaseFixture,
} from "./helpers/fixtures";

integrationDescribe("[E2E] Analytics — recursive CTE, window functions, time-in-status", () => {
  let booted: BootedApp;
  let fx: BaseFixture;
  let sprintId: number;

  // Tree fixtures
  let rootId: number;
  let aId: number;
  let bId: number;
  let aChildId: number;
  let bChildId: number;

  // Throughput fixtures
  let completedIssueIds: number[] = [];

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
    sprintId = await createSprint(booted.server, fx.projectId);

    // Build a 4-level tree:
    //   root
    //    ├── a
    //    │    └── aChild
    //    └── b
    //         └── bChild
    const root = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "Tree root",
      sprintId,
      reporterId: fx.userIds[0],
      assigneeId: fx.userIds[0],
      estimate: 5,
    });
    rootId = root.id;

    const a = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "Branch A",
      parentId: rootId,
      sprintId,
      reporterId: fx.userIds[1],
      assigneeId: fx.userIds[1],
      estimate: 3,
    });
    aId = a.id;

    const b = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "Branch B",
      parentId: rootId,
      sprintId,
      reporterId: fx.userIds[1],
      assigneeId: fx.userIds[2],
      estimate: 4,
    });
    bId = b.id;

    const aChild = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "A's child",
      parentId: aId,
      sprintId,
      reporterId: fx.userIds[2],
      assigneeId: fx.userIds[1],
      estimate: 2,
    });
    aChildId = aChild.id;

    const bChild = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "B's child",
      parentId: bId,
      sprintId,
      reporterId: fx.userIds[3],
      assigneeId: fx.userIds[2],
      estimate: 2,
    });
    bChildId = bChild.id;

    // Transition some issues through statuses so STATUS_CHANGED logs accumulate
    // and the throughput / burndown queries see completed work.
    for (const id of [rootId, aId, bId]) {
      const cur = await request(booted.server).get(`/issues/${id}`);
      const v0 = cur.body.version;

      const r1 = await request(booted.server)
        .patch(`/issues/${id}`)
        .send({ expectedVersion: v0, status: "IN_PROGRESS" })
        .expect(200);

      const r2 = await request(booted.server)
        .patch(`/issues/${id}`)
        .send({ expectedVersion: r1.body.version, status: "DONE" })
        .expect(200);

      completedIssueIds.push(id);
      expect(r2.body.completedAt).toBeTruthy();
    }
  }, 90000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30000);

  // ────────────────────────────────────────────────
  // Recursive CTE — issue tree
  // ────────────────────────────────────────────────
  describe("Recursive CTE issue tree", () => {
    it("returns the root + 4 descendants ordered by path", async () => {
      const res = await request(booted.server)
        .get(`/analytics/issues/${rootId}/tree`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(5);

      const root = res.body[0];
      expect(root.id).toBe(rootId);
      expect(root.depth).toBe(0);
    });

    it("depth values match each node's level", async () => {
      const res = await request(booted.server)
        .get(`/analytics/issues/${rootId}/tree`)
        .expect(200);

      const byId = new Map(res.body.map((r: any) => [r.id, r]));
      expect((byId.get(rootId) as any).depth).toBe(0);
      expect((byId.get(aId) as any).depth).toBe(1);
      expect((byId.get(bId) as any).depth).toBe(1);
      expect((byId.get(aChildId) as any).depth).toBe(2);
      expect((byId.get(bChildId) as any).depth).toBe(2);
    });

    it("path values reflect ancestor chain", async () => {
      const res = await request(booted.server)
        .get(`/analytics/issues/${rootId}/tree`)
        .expect(200);

      const aChild = res.body.find((r: any) => r.id === aChildId);
      expect(aChild.path).toBe(`${rootId}/${aId}/${aChildId}`);

      const bChild = res.body.find((r: any) => r.id === bChildId);
      expect(bChild.path).toBe(`${rootId}/${bId}/${bChildId}`);
    });

    it("maxDepth=1 returns root + direct children only", async () => {
      const res = await request(booted.server)
        .get(`/analytics/issues/${rootId}/tree`)
        .query({ maxDepth: 1 })
        .expect(200);

      expect(res.body.length).toBe(3); // root + a + b
      const ids = res.body.map((r: any) => r.id);
      expect(ids).toEqual(expect.arrayContaining([rootId, aId, bId]));
      expect(ids).not.toContain(aChildId);
      expect(ids).not.toContain(bChildId);
    });

    it("excludes soft-deleted descendants", async () => {
      await request(booted.server).delete(`/issues/${aChildId}`).expect(204);

      const res = await request(booted.server)
        .get(`/analytics/issues/${rootId}/tree`)
        .expect(200);

      const ids = res.body.map((r: any) => r.id);
      expect(ids).not.toContain(aChildId);
      expect(ids).toContain(bChildId);

      // Restore for downstream tests
      await request(booted.server).post(`/issues/${aChildId}/restore`).expect(204);
    });

    it("starts at the requested non-root id", async () => {
      const res = await request(booted.server)
        .get(`/analytics/issues/${aId}/tree`)
        .expect(200);

      const ids = res.body.map((r: any) => r.id);
      expect(ids).toContain(aId);
      expect(ids).toContain(aChildId);
      expect(ids).not.toContain(rootId);
      expect(ids).not.toContain(bId);
    });
  });

  // ────────────────────────────────────────────────
  // Sprint burndown — SUM() OVER (ORDER BY day)
  // ────────────────────────────────────────────────
  describe("Sprint burndown (window function)", () => {
    it("returns row shape matching {day, completedThatDay, cumulativeCompleted, remainingEstimate}", async () => {
      const res = await request(booted.server)
        .get(`/analytics/sprints/${sprintId}/burndown`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      for (const row of res.body) {
        expect(row).toHaveProperty("day");
        expect(typeof row.completedThatDay).toBe("number");
        expect(typeof row.cumulativeCompleted).toBe("number");
        expect(typeof row.remainingEstimate).toBe("number");
      }
    });

    it("cumulativeCompleted is non-decreasing", async () => {
      const res = await request(booted.server)
        .get(`/analytics/sprints/${sprintId}/burndown`)
        .expect(200);

      for (let i = 1; i < res.body.length; i++) {
        expect(res.body[i].cumulativeCompleted).toBeGreaterThanOrEqual(
          res.body[i - 1].cumulativeCompleted,
        );
      }
    });

    it("the final cumulativeCompleted equals total completed in sprint", async () => {
      const res = await request(booted.server)
        .get(`/analytics/sprints/${sprintId}/burndown`)
        .expect(200);

      const final = res.body[res.body.length - 1];
      expect(final.cumulativeCompleted).toBe(completedIssueIds.length);
    });
  });

  // ────────────────────────────────────────────────
  // Assignee throughput — ROW_NUMBER OVER (...)
  // ────────────────────────────────────────────────
  describe("Assignee throughput (ROW_NUMBER OVER)", () => {
    it("returns rows for completed issues, ranked starting at 1", async () => {
      const res = await request(booted.server)
        .get(`/analytics/projects/${fx.projectId}/throughput`)
        .query({ days: 365 })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].rankInProject).toBe(1);
    });

    it("rankInProject is strictly increasing", async () => {
      const res = await request(booted.server)
        .get(`/analytics/projects/${fx.projectId}/throughput`)
        .query({ days: 365 })
        .expect(200);

      for (let i = 1; i < res.body.length; i++) {
        expect(res.body[i].rankInProject).toBeGreaterThan(
          res.body[i - 1].rankInProject,
        );
      }
    });

    it("assignees with no completed issues do not appear", async () => {
      const res = await request(booted.server)
        .get(`/analytics/projects/${fx.projectId}/throughput`)
        .query({ days: 365 })
        .expect(200);

      const assigneeIds = res.body.map((r: any) => r.assigneeId);
      // userIds[3] never had an issue assigned that we marked DONE
      expect(assigneeIds).not.toContain(fx.userIds[3]);
    });

    it("includes averageCycleHours as a non-negative number", async () => {
      const res = await request(booted.server)
        .get(`/analytics/projects/${fx.projectId}/throughput`)
        .query({ days: 365 })
        .expect(200);

      for (const row of res.body) {
        expect(typeof row.averageCycleHours).toBe("number");
        expect(row.averageCycleHours).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ────────────────────────────────────────────────
  // Time in status — LAG/LEAD over activity_log
  // ────────────────────────────────────────────────
  describe("Time in status (LAG/LEAD over activity_log)", () => {
    it("returns one row per STATUS_CHANGED entry", async () => {
      // rootId went BACKLOG → IN_PROGRESS → DONE so we expect 2 transitions.
      const res = await request(booted.server)
        .get(`/analytics/issues/${rootId}/time-in-status`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });

    it("each row has issueId and status fields", async () => {
      const res = await request(booted.server)
        .get(`/analytics/issues/${rootId}/time-in-status`)
        .expect(200);

      for (const row of res.body) {
        expect(row.issueId).toBe(rootId);
        expect(typeof row.status).toBe("string");
        expect(typeof row.enteredAt).toBe("string");
      }
    });

    it("the latest entry has leftAt = null and hoursInStatus = null", async () => {
      const res = await request(booted.server)
        .get(`/analytics/issues/${rootId}/time-in-status`)
        .expect(200);

      const last = res.body[res.body.length - 1];
      expect(last.leftAt).toBeNull();
      expect(last.hoursInStatus).toBeNull();
    });

    it("returns empty array for an issue with no status transitions", async () => {
      const fresh = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Never transitioned",
      });

      const res = await request(booted.server)
        .get(`/analytics/issues/${fresh.id}/time-in-status`)
        .expect(200);

      expect(res.body).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────
  // Weekly lead time
  // ────────────────────────────────────────────────
  describe("Weekly lead time", () => {
    it("returns rows aggregating completed issues per week", async () => {
      const res = await request(booted.server)
        .get(`/analytics/projects/${fx.projectId}/lead-time`)
        .query({ days: 365 })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      const total = res.body.reduce(
        (acc: number, r: any) => acc + Number(r.closedCount),
        0,
      );
      expect(total).toBe(completedIssueIds.length);

      for (const row of res.body) {
        expect(row.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}/);
        expect(typeof row.leadTimeHours).toBe("number");
      }
    });
  });
});
