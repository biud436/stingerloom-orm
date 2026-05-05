import {
  authedAgent,
  bootApp,
  BootedApp,
  integrationDescribe,
  shutdownApp,
} from "./helpers/test-app";
import {
  BaseFixture,
  createBaseFixture,
  createIssue,
} from "./helpers/fixtures";

integrationDescribe(
  "[E2E] SavedFilters — JQL-like AST → SelectQueryBuilder",
  () => {
    let booted: BootedApp;
    let fx: BaseFixture;
    let api: ReturnType<typeof authedAgent>;

    beforeAll(async () => {
      booted = await bootApp();
      fx = await createBaseFixture(booted.server);
      api = authedAgent(booted.server, fx.ownerToken);

      // Seed a mixed-status, mixed-assignee issue set.
      await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Backlog A (owner)",
        status: "BACKLOG",
        assigneeId: fx.userIds[0],
        customFields: { severity: "S0" },
      });
      await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Backlog B (other)",
        status: "BACKLOG",
        assigneeId: fx.userIds[1],
        customFields: { severity: "S2" },
      });
      await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "InProgress A (owner)",
        status: "IN_PROGRESS",
        assigneeId: fx.userIds[0],
      });
      await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Done A (other)",
        status: "DONE",
        assigneeId: fx.userIds[1],
      });
    }, 60_000);

    afterAll(async () => {
      await shutdownApp(booted);
    }, 30_000);

    it("creates a filter and runs it (status eq BACKLOG)", async () => {
      const created = await api
        .post("/saved-filters")
        .send({
          workspaceId: fx.workspaceId,
          name: "All backlog",
          definition: {
            and: [{ field: "status", op: "eq", value: "BACKLOG" }],
          },
        })
        .expect(201);
      expect(created.body.id).toBeGreaterThan(0);

      const run = await api
        .get(`/saved-filters/${created.body.id}/run`)
        .expect(200);
      expect(run.body).toHaveProperty("data");
      expect(Array.isArray(run.body.data)).toBe(true);
      expect(run.body.data.length).toBeGreaterThanOrEqual(2);
      for (const issue of run.body.data) {
        expect(issue.status).toBe("BACKLOG");
      }
    });

    it("rejects unknown fields with 400 UNKNOWN_FIELD", async () => {
      const r = await api
        .post("/saved-filters")
        .send({
          workspaceId: fx.workspaceId,
          name: "Sketchy",
          definition: { field: "secret_field", op: "eq", value: 1 },
        })
        .expect(400);
      const code = r.body?.code ?? r.body?.error?.code ?? r.body?.message?.code;
      const text = JSON.stringify(r.body);
      expect(text).toContain("UNKNOWN_FIELD");
      // tolerate both flat and nested error envelopes
      void code;
    });

    it("supports op: \"me\" — bound to the authenticated caller", async () => {
      const created = await api
        .post("/saved-filters")
        .send({
          workspaceId: fx.workspaceId,
          name: "Mine",
          definition: {
            and: [
              { field: "assigneeId", op: "me" },
              { field: "projectId", op: "eq", value: fx.projectId },
            ],
          },
        })
        .expect(201);

      const run = await api
        .get(`/saved-filters/${created.body.id}/run`)
        .expect(200);
      expect(run.body.data.length).toBeGreaterThanOrEqual(2);
      for (const issue of run.body.data) {
        expect(issue.assigneeId).toBe(fx.ownerId);
      }
    });

    it("rejects deeply nested filters (>5 depth) with 400", async () => {
      // depth = 7 trees: and(and(and(and(and(and(and(leaf))))))).
      let leaf: any = { field: "status", op: "eq", value: "BACKLOG" };
      for (let i = 0; i < 7; i++) {
        leaf = { and: [leaf] };
      }
      const r = await api
        .post("/saved-filters")
        .send({
          workspaceId: fx.workspaceId,
          name: "Too deep",
          definition: leaf,
        })
        .expect(400);
      expect(JSON.stringify(r.body)).toContain("FILTER_TOO_DEEP");
    });

    it("supports jsonEq on customFields", async () => {
      const created = await api
        .post("/saved-filters")
        .send({
          workspaceId: fx.workspaceId,
          name: "S0 issues",
          definition: {
            and: [
              {
                field: "customFields",
                op: "jsonEq",
                path: ["severity"],
                value: "S0",
              },
              { field: "projectId", op: "eq", value: fx.projectId },
            ],
          },
        })
        .expect(201);

      const run = await api
        .get(`/saved-filters/${created.body.id}/run`)
        .expect(200);
      expect(run.body.data.length).toBeGreaterThanOrEqual(1);
      for (const issue of run.body.data) {
        expect(issue.customFields?.severity).toBe("S0");
      }
    });

    it("rejects jsonEq on a non-JSON field with 400 UNKNOWN_FIELD", async () => {
      const r = await api
        .post("/saved-filters")
        .send({
          workspaceId: fx.workspaceId,
          name: "Bad jsonEq",
          definition: {
            field: "status",
            op: "jsonEq",
            path: ["x"],
            value: "y",
          },
        })
        .expect(400);
      expect(JSON.stringify(r.body)).toContain("UNKNOWN_FIELD");
    });

    it("lists, fetches, and deletes filters", async () => {
      const created = await api
        .post("/saved-filters")
        .send({
          workspaceId: fx.workspaceId,
          name: "Throwaway",
          definition: { field: "status", op: "eq", value: "BACKLOG" },
        })
        .expect(201);

      const list = await api.get("/saved-filters").expect(200);
      expect(Array.isArray(list.body)).toBe(true);
      expect(
        list.body.some((f: { id: number }) => f.id === created.body.id),
      ).toBe(true);

      const got = await api
        .get(`/saved-filters/${created.body.id}`)
        .expect(200);
      expect(got.body.id).toBe(created.body.id);

      await api.delete(`/saved-filters/${created.body.id}`).expect(204);
      await api.get(`/saved-filters/${created.body.id}`).expect(404);
    });

    it("cursor pagination yields a stable second page", async () => {
      const created = await api
        .post("/saved-filters")
        .send({
          workspaceId: fx.workspaceId,
          name: "All in project",
          definition: {
            field: "projectId",
            op: "eq",
            value: fx.projectId,
          },
        })
        .expect(201);

      const page1 = await api
        .get(`/saved-filters/${created.body.id}/run`)
        .query({ take: 2 })
        .expect(200);
      expect(page1.body.data.length).toBe(2);
      expect(page1.body.hasNextPage).toBe(true);
      expect(page1.body.nextCursor).toBeTruthy();

      const page2 = await api
        .get(`/saved-filters/${created.body.id}/run`)
        .query({ take: 2, cursor: page1.body.nextCursor })
        .expect(200);
      const ids1 = page1.body.data.map((i: { id: number }) => i.id);
      const ids2 = page2.body.data.map((i: { id: number }) => i.id);
      for (const id of ids2) expect(ids1).not.toContain(id);
    });
  },
);
