import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  authedAgent,
  BootedApp,
} from "./helpers/test-app";
import {
  createBaseFixture,
  createIssue,
  createSprint,
  BaseFixture,
} from "./helpers/fixtures";

/**
 * Time tracking + sprint velocity.
 *
 * Phase 1 closes the time-tracking gap from #304 with a `WorkLog` entity
 * and two ORM-stress queries:
 *   1. `dailyHoursByUser` — GROUP BY DATE(logged_at), portable across
 *      MySQL (DATE(...)) and PostgreSQL (date_trunc('day', ...)).
 *   2. `sprintVelocity`   — AVG(SUM(hours)) OVER (ORDER BY start_date
 *      ROWS BETWEEN N PRECEDING AND CURRENT ROW), the rolling-window
 *      moving average that #304 calls out as the velocity benchmark.
 *
 * The test seeds three sprints with descending start dates and known hour
 * totals so the rolling-3-sprint average has a deterministic series.
 */
integrationDescribe("[E2E] WorkLogs — time tracking + sprint velocity rolling window", () => {
  let booted: BootedApp;
  let fx: BaseFixture;
  let api: ReturnType<typeof authedAgent>;
  let issueIds: number[] = [];
  let sprintIds: number[] = [];

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
    api = authedAgent(booted.server, fx.ownerToken);
  }, 60_000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30_000);

  // ────────────────────────────────────────────────
  // Issue + sprint scaffolding
  // ────────────────────────────────────────────────
  describe("Setup", () => {
    it("creates 3 sprints (oldest → newest) and 3 issues per sprint", async () => {
      // Three sprints spaced ~14 days apart; createSprint centers around now,
      // so we offset by passing a custom helper invocation per sprint.
      // Reuse the helper for the active sprint (centered on today), then
      // create the older two by directly POSTing with explicit start dates.
      const today = new Date();
      const offsets = [-28, -14, 0];
      for (let i = 0; i < offsets.length; i++) {
        const start = new Date(today.getTime() + offsets[i] * 86400000);
        const end = new Date(start.getTime() + 7 * 86400000);
        const r = await api
          .post("/sprints")
          .send({
            projectId: fx.projectId,
            name: `S${i}`,
            status: "ACTIVE",
            startDate: start.toISOString().slice(0, 10),
            endDate: end.toISOString().slice(0, 10),
          })
          .expect(201);
        sprintIds.push(r.body.id);
      }

      // Three issues per sprint so per-sprint hour totals look realistic.
      for (const sprintId of sprintIds) {
        for (let i = 0; i < 3; i++) {
          const issue = await createIssue(booted.server, {
            projectId: fx.projectId,
            title: `Sprint ${sprintId} issue ${i}`,
            status: "BACKLOG",
            sprintId,
          });
          issueIds.push(issue.id);
        }
      }
      expect(sprintIds).toHaveLength(3);
      expect(issueIds).toHaveLength(9);
    });
  });

  // ────────────────────────────────────────────────
  // CRUD
  // ────────────────────────────────────────────────
  describe("WorkLog CRUD", () => {
    it("POST /issues/:id/work-logs → 201", async () => {
      const r = await api
        .post(`/issues/${issueIds[0]}/work-logs`)
        .send({ hours: 1.5, description: "investigated repro" })
        .expect(201);
      expect(r.body.hours).toBe(1.5);
      expect(r.body.userId).toBe(fx.ownerId);
      expect(r.body.issueId).toBe(issueIds[0]);
      expect(r.body.loggedAt).toBeDefined();
    });

    it("rejects hours <= 0", async () => {
      await api
        .post(`/issues/${issueIds[0]}/work-logs`)
        .send({ hours: 0 })
        .expect(400);
    });

    it("rejects hours > 24", async () => {
      await api
        .post(`/issues/${issueIds[0]}/work-logs`)
        .send({ hours: 25 })
        .expect(400);
    });

    it("GET /issues/:id/work-logs returns the log", async () => {
      const r = await api.get(`/issues/${issueIds[0]}/work-logs`).expect(200);
      expect(r.body).toHaveLength(1);
      expect(Number(r.body[0].hours)).toBe(1.5);
    });

    it("PATCH /work-logs/:id updates hours and description", async () => {
      const list = await api.get(`/issues/${issueIds[0]}/work-logs`).expect(200);
      const id = list.body[0].id;
      const r = await api
        .patch(`/work-logs/${id}`)
        .send({ hours: 2, description: "fixed it" })
        .expect(200);
      expect(Number(r.body.hours)).toBe(2);
      expect(r.body.description).toBe("fixed it");
    });

    it("DELETE /work-logs/:id → 204 then 404", async () => {
      const list = await api.get(`/issues/${issueIds[0]}/work-logs`).expect(200);
      const id = list.body[0].id;
      await api.delete(`/work-logs/${id}`).expect(204);
      await api.get(`/work-logs/${id}`).expect(404);
    });
  });

  // ────────────────────────────────────────────────
  // Per-day aggregation
  // ────────────────────────────────────────────────
  describe("Per-user daily hours", () => {
    it("GROUP BY DATE(logged_at) sums today's hours across issues", async () => {
      const today = new Date().toISOString().slice(0, 10);
      // Two logs same day, different issues
      await api
        .post(`/issues/${issueIds[1]}/work-logs`)
        .send({ hours: 1.25, loggedAt: `${today}T09:00:00.000Z` })
        .expect(201);
      await api
        .post(`/issues/${issueIds[2]}/work-logs`)
        .send({ hours: 0.75, loggedAt: `${today}T15:00:00.000Z` })
        .expect(201);

      const r = await api
        .get("/users/me/work-logs/daily")
        .query({ days: 30 })
        .expect(200);
      const todayRow = (r.body as { day: string; hours: number }[]).find(
        (row) => row.day === today,
      );
      expect(todayRow).toBeDefined();
      expect(todayRow!.hours).toBeGreaterThanOrEqual(2);
    });
  });

  // ────────────────────────────────────────────────
  // Sprint velocity rolling window
  // ────────────────────────────────────────────────
  describe("Sprint velocity rolling-window average", () => {
    it("seeds known hours per sprint then verifies the rolling avg", async () => {
      // Hours per sprint: S0=10, S1=20, S2=30 (oldest to newest).
      // Rolling 3-sprint avg series should be:
      //   S0 = 10                (only itself in window)
      //   S1 = (10 + 20) / 2 = 15
      //   S2 = (10 + 20 + 30) / 3 = 20
      const hoursPerSprint = [10, 20, 30];
      // Issues are seeded sprint-by-sprint, 3 issues per sprint.
      // Spread the hours across the 3 issues of each sprint so we exercise
      // the LEFT JOIN+SUM path rather than packing everything onto one issue.
      for (let s = 0; s < sprintIds.length; s++) {
        const total = hoursPerSprint[s];
        const offset = s * 3;
        const allocations = [total * 0.5, total * 0.3, total * 0.2];
        for (let i = 0; i < 3; i++) {
          await api
            .post(`/issues/${issueIds[offset + i]}/work-logs`)
            .send({ hours: allocations[i] })
            .expect(201);
        }
      }

      const r = await api
        .get(`/analytics/projects/${fx.projectId}/velocity`)
        .query({ window: 3 })
        .expect(200);
      const rows = r.body as Array<{
        sprintId: number;
        sprintName: string;
        completedHours: number;
        rollingAverageHours: number;
      }>;

      // Filter to only the sprints we created (other tests in the same DB
      // may have leaked sprints into the project; we only assert on ours).
      const ours = rows.filter((row) => sprintIds.includes(row.sprintId));
      // Order returned by the service is start_date ASC — which matches our
      // seed order (oldest to newest sprint).
      const ordered = ours.sort(
        (a, b) => sprintIds.indexOf(a.sprintId) - sprintIds.indexOf(b.sprintId),
      );

      expect(ordered).toHaveLength(3);
      expect(ordered[0].completedHours).toBe(10);
      expect(ordered[1].completedHours).toBe(20);
      expect(ordered[2].completedHours).toBe(30);

      // Rolling 3-sprint averages, allowing for fp rounding from the SQL
      // engine's AVG implementation.
      expect(ordered[0].rollingAverageHours).toBeCloseTo(10, 1);
      expect(ordered[1].rollingAverageHours).toBeCloseTo(15, 1);
      expect(ordered[2].rollingAverageHours).toBeCloseTo(20, 1);
    });

    it("respects a custom window (1 = no smoothing → equals completedHours)", async () => {
      const r = await api
        .get(`/analytics/projects/${fx.projectId}/velocity`)
        .query({ window: 1 })
        .expect(200);
      const ours = (r.body as Array<{
        sprintId: number;
        completedHours: number;
        rollingAverageHours: number;
      }>).filter((row) => sprintIds.includes(row.sprintId));
      for (const row of ours) {
        expect(row.rollingAverageHours).toBeCloseTo(row.completedHours, 1);
      }
    });
  });
});
