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
  BaseFixture,
} from "./helpers/fixtures";

integrationDescribe("[E2E] Workflows — per-project state machine", () => {
  let booted: BootedApp;
  let fx: BaseFixture;
  let api: ReturnType<typeof authedAgent>;

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
    api = authedAgent(booted.server, fx.ownerToken);
  }, 60_000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30_000);

  describe("Default workflow seeding", () => {
    it("GET /projects/:id/workflow returns the seeded default chain", async () => {
      const r = await api.get(`/projects/${fx.projectId}/workflow`).expect(200);
      expect(r.body.projectId).toBe(fx.projectId);
      expect(r.body.states).toEqual(
        expect.arrayContaining([
          "BACKLOG",
          "TODO",
          "IN_PROGRESS",
          "IN_REVIEW",
          "DONE",
          "CANCELED",
        ]),
      );
      const pairs = r.body.transitions.map(
        (t: { fromState: string; toState: string }) => `${t.fromState}->${t.toState}`,
      );
      // Forward chain
      expect(pairs).toEqual(
        expect.arrayContaining([
          "BACKLOG->TODO",
          "TODO->IN_PROGRESS",
          "IN_PROGRESS->IN_REVIEW",
          "IN_REVIEW->DONE",
        ]),
      );
      // Cancel from any state
      expect(pairs).toEqual(
        expect.arrayContaining([
          "BACKLOG->CANCELED",
          "TODO->CANCELED",
          "IN_PROGRESS->CANCELED",
        ]),
      );
      // Reverse from DONE
      expect(pairs).toContain("DONE->IN_REVIEW");
    });

    it("GET is idempotent — second read does not double-seed transitions", async () => {
      const a = await api.get(`/projects/${fx.projectId}/workflow`).expect(200);
      const b = await api.get(`/projects/${fx.projectId}/workflow`).expect(200);
      expect(b.body.transitions.length).toBe(a.body.transitions.length);
    });
  });

  describe("Custom transition rules", () => {
    it("POST a custom transition (BACKLOG → IN_REVIEW) returns 201", async () => {
      const r = await api
        .post(`/projects/${fx.projectId}/workflow/transitions`)
        .send({ fromState: "BACKLOG", toState: "IN_REVIEW" })
        .expect(201);
      expect(r.body.fromState).toBe("BACKLOG");
      expect(r.body.toState).toBe("IN_REVIEW");
      expect(r.body.id).toBe("BACKLOG__IN_REVIEW");
    });

    it("PATCH issue with status BACKLOG → IN_REVIEW now succeeds", async () => {
      const issue = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Fast-track to review",
        status: "BACKLOG",
      });
      const r = await api
        .patch(`/issues/${issue.id}`)
        .send({ expectedVersion: issue.version, status: "IN_REVIEW" })
        .expect(200);
      expect(r.body.status).toBe("IN_REVIEW");
    });

    it("PATCH BACKLOG → DONE returns 422 WORKFLOW_VIOLATION TRANSITION_NOT_ALLOWED", async () => {
      const issue = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Skip too far",
        status: "BACKLOG",
      });
      const r = await api
        .patch(`/issues/${issue.id}`)
        .send({ expectedVersion: issue.version, status: "DONE" })
        .expect(422);
      expect(r.body.code).toBe("WORKFLOW_VIOLATION");
      // The envelope carries the rule details under `details` (the original
      // HttpException response object); the AllExceptionsFilter relays the
      // structured payload.
      const details = r.body.details ?? r.body;
      expect(details.rule).toBe("TRANSITION_NOT_ALLOWED");
      expect(details.fromState).toBe("BACKLOG");
      expect(details.toState).toBe("DONE");
    });

    it("DELETE removes a custom transition", async () => {
      // Add then delete a unique pair so we don't hit the previous test's row.
      await api
        .post(`/projects/${fx.projectId}/workflow/transitions`)
        .send({ fromState: "BACKLOG", toState: "DONE" })
        .expect(201);

      await api
        .delete(
          `/projects/${fx.projectId}/workflow/transitions/BACKLOG__DONE`,
        )
        .expect(204);

      const r = await api.get(`/projects/${fx.projectId}/workflow`).expect(200);
      const pairs = r.body.transitions.map(
        (t: { fromState: string; toState: string }) => `${t.fromState}->${t.toState}`,
      );
      expect(pairs).not.toContain("BACKLOG->DONE");
    });
  });

  describe("Required-fields rule", () => {
    it("POST a transition requiring assigneeId then PATCH unassigned issue → 422 REQUIRED_FIELDS_MISSING", async () => {
      // Create a fresh project so the new transition does not conflict with
      // earlier specs and the BACKLOG→DONE pair is a clean slate.
      const proj = await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: "Reqs project",
          key: "RQ" + Math.floor(Math.random() * 99),
        })
        .expect(201);
      const projectId = proj.body.id as number;

      // Seed default first so the GET-then-add flow is exercised.
      await api.get(`/projects/${projectId}/workflow`).expect(200);

      // BACKLOG→DONE is not in the default chain, add it with requiredFields.
      await api
        .post(`/projects/${projectId}/workflow/transitions`)
        .send({
          fromState: "BACKLOG",
          toState: "DONE",
          requiredFields: ["assigneeId"],
        })
        .expect(201);

      const issue = await createIssue(booted.server, {
        projectId,
        title: "Unassigned terminal jump",
        status: "BACKLOG",
      });

      const r = await api
        .patch(`/issues/${issue.id}`)
        .send({ expectedVersion: issue.version, status: "DONE" })
        .expect(422);
      expect(r.body.code).toBe("WORKFLOW_VIOLATION");
      const details = r.body.details ?? r.body;
      expect(details.rule).toBe("REQUIRED_FIELDS_MISSING");
      expect(details.missing).toEqual(expect.arrayContaining(["assigneeId"]));

      // Same patch with assigneeId set should succeed.
      const ok = await api
        .patch(`/issues/${issue.id}`)
        .send({
          expectedVersion: issue.version,
          status: "DONE",
          assigneeId: fx.userIds[1],
        })
        .expect(200);
      expect(ok.body.status).toBe("DONE");
      expect(ok.body.completedAt).toBeTruthy();
    });
  });

  describe("Terminal state side-effects", () => {
    it("entering DONE auto-sets completedAt", async () => {
      const issue = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Cycle-time check",
        status: "BACKLOG",
      });

      // BACKLOG → IN_REVIEW (added in earlier spec) → DONE
      const a = await api
        .patch(`/issues/${issue.id}`)
        .send({ expectedVersion: issue.version, status: "IN_REVIEW" })
        .expect(200);

      const done = await api
        .patch(`/issues/${issue.id}`)
        .send({ expectedVersion: a.body.version, status: "DONE" })
        .expect(200);

      expect(done.body.status).toBe("DONE");
      expect(done.body.completedAt).toBeTruthy();
      expect(done.body.completedAt).not.toBeNull();
    });
  });
});
