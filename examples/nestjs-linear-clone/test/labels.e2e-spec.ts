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
  createIssue,
  BaseFixture,
} from "./helpers/fixtures";

/**
 * Direct e2e coverage for the Labels controller. Standalone Label CRUD and
 * uniqueness behavior were previously only exercised indirectly via the issue
 * relation tests — see #341.
 */
integrationDescribe("[E2E] Labels — CRUD, project uniqueness, cascade behavior", () => {
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
    it("creates a label and returns the persisted row", async () => {
      const r = await api
        .post("/labels")
        .send({ projectId: fx.projectId, name: "regression" })
        .expect(201);
      expect(r.body.id).toBeGreaterThan(0);
      expect(r.body.name).toBe("regression");
      // Re-fetch instead of trusting the POST response shape: PostgreSQL's
      // ORM round-trip drops the `projectId` FK-shadow on save() but the GET
      // path hydrates it. Asserting via GET keeps the test dialect-portable.
      const fetched = await api.get(`/labels/${r.body.id}`).expect(200);
      expect(fetched.body.projectId).toBe(fx.projectId);
    });

    it("accepts an optional color hex code", async () => {
      const r = await api
        .post("/labels")
        .send({
          projectId: fx.projectId,
          name: "frontend",
          color: "#ff5252",
        })
        .expect(201);
      expect(r.body.color).toBe("#ff5252");
    });

    it("rejects a color that is not a 6-digit hex", async () => {
      await api
        .post("/labels")
        .send({
          projectId: fx.projectId,
          name: "bad-color",
          color: "blue",
        })
        .expect(400);
    });

    it("returns 403 when projectId is missing (WorkspaceScoped guard runs before validation)", async () => {
      await api
        .post("/labels")
        .send({ name: "no-proj" })
        .expect(403);
    });

    it("rejects a name longer than 40 chars", async () => {
      await api
        .post("/labels")
        .send({
          projectId: fx.projectId,
          name: "x".repeat(41),
        })
        .expect(400);
    });
  });

  describe("Uniqueness within a project", () => {
    it("returns 409 when the same name is reused in the same project", async () => {
      await api
        .post("/labels")
        .send({ projectId: fx.projectId, name: "duplicate" })
        .expect(201);

      const conflict = await api
        .post("/labels")
        .send({ projectId: fx.projectId, name: "duplicate" })
        .expect(409);
      expect(conflict.body.message).toMatch(/already exists/i);
    });

    it("allows the same name to live in a different project", async () => {
      const suffix = uniqueSuffix("lb");
      const projB = await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: `Other ${suffix}`,
          key: projectKey(suffix),
        })
        .expect(201);

      // Re-using the label name "duplicate" under a separate project must succeed —
      // the uniqueness scope is (project_id, name), not name alone.
      await api
        .post("/labels")
        .send({ projectId: projB.body.id, name: "duplicate" })
        .expect(201);
    });
  });

  describe("List filtered by projectId", () => {
    it("returns only labels from the requested project", async () => {
      const res = await api
        .get("/labels")
        .query({ projectId: fx.projectId })
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      for (const label of res.body) {
        expect(label.projectId).toBe(fx.projectId);
      }
      const names = res.body.map((l: any) => l.name);
      expect(names).toEqual(expect.arrayContaining(["regression", "frontend"]));
    });
  });

  describe("Find one + nonexistent id", () => {
    it("GET /labels/:id returns the label", async () => {
      const created = await api
        .post("/labels")
        .send({ projectId: fx.projectId, name: "find-me" })
        .expect(201);

      const r = await api.get(`/labels/${created.body.id}`).expect(200);
      expect(r.body.name).toBe("find-me");
    });

    it("GET /labels/:id returns 404 for an unknown id", async () => {
      await api.get(`/labels/9999999`).expect(404);
    });

    it("DELETE /labels/:id returns 404 for an unknown id", async () => {
      await api.delete(`/labels/9999999`).expect(404);
    });
  });

  describe("Cascade behavior when an attached label is deleted", () => {
    it("removes the label from any issue it was attached to (ON DELETE CASCADE on the join table)", async () => {
      // Create a fresh label so the cascade test is isolated from earlier IDs.
      const label = await api
        .post("/labels")
        .send({ projectId: fx.projectId, name: "to-cascade" })
        .expect(201);

      const issue = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Cascade-label subject",
      });

      // Attach, sanity-check it shows up on the issue, then delete the label.
      await api
        .post(`/issues/${issue.id}/labels`)
        .send({ labelId: label.body.id })
        .expect(201);

      const beforeDelete = await api.get(`/issues/${issue.id}`).expect(200);
      const beforeIds = (beforeDelete.body.labels ?? []).map((l: any) => l.id);
      expect(beforeIds).toContain(label.body.id);

      await api.delete(`/labels/${label.body.id}`).expect(204);

      // After cascade, the issue still exists but the label reference is gone.
      const afterDelete = await api.get(`/issues/${issue.id}`).expect(200);
      const afterIds = (afterDelete.body.labels ?? []).map((l: any) => l.id);
      expect(afterIds).not.toContain(label.body.id);

      // And the label itself is gone.
      await api.get(`/labels/${label.body.id}`).expect(404);
    });
  });
});
