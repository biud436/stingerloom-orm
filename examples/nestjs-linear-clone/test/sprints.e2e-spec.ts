import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  authedAgent,
  BootedApp,
  uniqueSuffix,
  projectKey,
} from "./helpers/test-app";
import {
  createBaseFixture,
  BaseFixture,
} from "./helpers/fixtures";

/**
 * Direct e2e coverage for Sprints CRUD. Sprints were previously exercised only
 * as a side-effect of the work-logs fixture, leaving date validation, status
 * transitions, and the projectId filter unverified — see #341.
 */
integrationDescribe("[E2E] Sprints — CRUD, status transitions, projectId filter", () => {
  let booted: BootedApp;
  let fx: BaseFixture;
  let api: ReturnType<typeof authedAgent>;

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
    api = authedAgent(booted.server, fx.ownerToken);
  }, 60000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30000);

  describe("Create", () => {
    it("creates a sprint with valid date range and PLANNED status", async () => {
      const r = await api
        .post("/sprints")
        .send({
          projectId: fx.projectId,
          name: "Sprint A",
          status: "PLANNED",
          startDate: "2026-04-01",
          endDate: "2026-04-14",
        })
        .expect(201);
      expect(r.body.id).toBeGreaterThan(0);
      expect(r.body.status).toBe("PLANNED");
      expect(r.body.name).toBe("Sprint A");
    });

    it("rejects a malformed startDate string", async () => {
      await api
        .post("/sprints")
        .send({
          projectId: fx.projectId,
          name: "Sprint bad-date",
          status: "PLANNED",
          startDate: "not-a-date",
        })
        .expect(400);
    });

    it("rejects an unknown status value", async () => {
      await api
        .post("/sprints")
        .send({
          projectId: fx.projectId,
          name: "Sprint bad-status",
          status: "WAT",
        })
        .expect(400);
    });

    it("returns 403 when projectId is missing (WorkspaceScoped guard runs before validation)", async () => {
      await api
        .post("/sprints")
        .send({
          name: "Sprint no-proj",
          status: "PLANNED",
        })
        .expect(403);
    });
  });

  describe("Status transitions PLANNED → ACTIVE → COMPLETED", () => {
    let sprintId: number;

    beforeAll(async () => {
      const r = await api
        .post("/sprints")
        .send({
          projectId: fx.projectId,
          name: "Sprint lifecycle",
          status: "PLANNED",
          startDate: "2026-04-15",
          endDate: "2026-04-28",
        })
        .expect(201);
      sprintId = r.body.id;
    });

    it("advances PLANNED → ACTIVE", async () => {
      const r = await api
        .patch(`/sprints/${sprintId}`)
        .send({ status: "ACTIVE" })
        .expect(200);
      expect(r.body.status).toBe("ACTIVE");

      const fetched = await api.get(`/sprints/${sprintId}`).expect(200);
      expect(fetched.body.status).toBe("ACTIVE");
    });

    it("advances ACTIVE → COMPLETED", async () => {
      const r = await api
        .patch(`/sprints/${sprintId}`)
        .send({ status: "COMPLETED" })
        .expect(200);
      expect(r.body.status).toBe("COMPLETED");
    });

    it("rejects unknown status on update", async () => {
      await api
        .patch(`/sprints/${sprintId}`)
        .send({ status: "WHATEVER" })
        .expect(400);
    });
  });

  describe("List filtered by projectId", () => {
    let otherProjectId: number;

    beforeAll(async () => {
      // Spin up a second project under the same workspace so we can prove the
      // filter — its sprints must not leak into the original project's list.
      const suffix = uniqueSuffix("sp");
      const projB = await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: `Other ${suffix}`,
          key: projectKey(suffix),
        })
        .expect(201);
      otherProjectId = projB.body.id;

      await api
        .post("/sprints")
        .send({
          projectId: otherProjectId,
          name: "Other-project sprint",
          status: "PLANNED",
        })
        .expect(201);
    });

    it("returns only sprints belonging to the requested project", async () => {
      const inA = await api
        .get("/sprints")
        .query({ projectId: fx.projectId })
        .expect(200);
      expect(Array.isArray(inA.body)).toBe(true);
      expect(inA.body.length).toBeGreaterThanOrEqual(2);
      for (const sprint of inA.body) {
        expect(sprint.projectId).toBe(fx.projectId);
      }
    });

    it("returns the sprint from the second project under that filter", async () => {
      const inB = await api
        .get("/sprints")
        .query({ projectId: otherProjectId })
        .expect(200);
      expect(inB.body.length).toBe(1);
      expect(inB.body[0].projectId).toBe(otherProjectId);
      expect(inB.body[0].name).toBe("Other-project sprint");
    });
  });

  describe("Lookup, update, delete on nonexistent ids", () => {
    const phantomId = 9_999_999;

    it("GET /sprints/:id returns 404 for an unknown id", async () => {
      await api.get(`/sprints/${phantomId}`).expect(404);
    });

    it("PATCH /sprints/:id returns 404 for an unknown id", async () => {
      await api
        .patch(`/sprints/${phantomId}`)
        .send({ status: "ACTIVE" })
        .expect(404);
    });

    it("DELETE /sprints/:id returns 404 for an unknown id", async () => {
      await api.delete(`/sprints/${phantomId}`).expect(404);
    });
  });

  describe("Delete", () => {
    it("removes the sprint and a follow-up GET returns 404", async () => {
      const created = await api
        .post("/sprints")
        .send({
          projectId: fx.projectId,
          name: "Sprint to delete",
          status: "PLANNED",
        })
        .expect(201);

      await api.delete(`/sprints/${created.body.id}`).expect(204);
      await api.get(`/sprints/${created.body.id}`).expect(404);
    });
  });
});
