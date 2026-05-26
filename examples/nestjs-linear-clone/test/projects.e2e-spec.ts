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

/**
 * Direct e2e coverage for the Projects controller. Project creation with
 * `customFieldSchema`, schema updates, key uniqueness, and the hard-delete
 * path were previously not asserted at the HTTP layer — see #341. Projects
 * do not implement soft-delete, so the "restore if supported" branch of the
 * plan reduces to a hard-delete + 404 verification here.
 */
integrationDescribe("[E2E] Projects — CRUD, customFieldSchema lifecycle, key uniqueness", () => {
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

  // MariaDB returns JSON columns as raw text strings (the ORM hands them to
  // the controller as JSON.stringify output); PostgreSQL returns parsed
  // objects. Normalize before deep-equal so the test covers both dialects.
  function parseCustomFields(value: unknown): Record<string, unknown> {
    return typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>);
  }

  // Project keys must match /^[A-Z][A-Z0-9]{1,5}$/. uniqueSuffix() collides
  // when many keys are generated inside the same millisecond because most of
  // its randomness lives in the trailing bytes that slice(0, 6) drops. We
  // derive each key from random uppercase alphanumerics instead so the
  // uniqueness constraint isn't accidentally tripped during the spec.
  const KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  function freshKey(): string {
    let key = "P";
    for (let i = 0; i < 5; i++) {
      key += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
    }
    return key;
  }

  describe("Create", () => {
    it("creates a project with a customFieldSchema and echoes the schema back", async () => {
      const schema = {
        fields: [
          { key: "severity", type: "enum", options: ["S0", "S1", "S2", "S3"] },
          { key: "customer", type: "string" },
        ],
      };
      const r = await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: "Mobile",
          key: freshKey(),
          customFieldSchema: schema,
        })
        .expect(201);
      expect(r.body.id).toBeGreaterThan(0);
      // PostgreSQL's ORM save() returns the row without the JSON column
      // populated, so we re-fetch to assert persistence — both dialects
      // round-trip the column identically on read.
      const fetched = await api.get(`/projects/${r.body.id}`).expect(200);
      expect(parseCustomFields(fetched.body.customFieldSchema)).toEqual(schema);
    });

    it("rejects a key that violates the regex (^[A-Z][A-Z0-9]{1,5}$)", async () => {
      await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: "Bad key",
          key: "lowercase",
        })
        .expect(400);
    });

    it("rejects a name longer than 120 chars", async () => {
      await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: "x".repeat(121),
          key: freshKey(),
        })
        .expect(400);
    });

    it("returns 403 when workspaceId is missing (WorkspaceScoped guard runs before validation)", async () => {
      await api
        .post("/projects")
        .send({ name: "No-workspace", key: freshKey() })
        .expect(403);
    });

    it("returns 409 when the same key is reused within a workspace", async () => {
      const key = freshKey();
      await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: "First",
          key,
        })
        .expect(201);
      const conflict = await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: "Second",
          key,
        })
        .expect(409);
      expect(conflict.body.message).toMatch(/already exists/i);
    });
  });

  describe("customFieldSchema lifecycle", () => {
    let projectId: number;
    let issueId: number;

    beforeAll(async () => {
      const proj = await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: "Schema lifecycle",
          key: freshKey(),
          customFieldSchema: {
            fields: [
              { key: "severity", type: "enum", options: ["S0", "S1"] },
            ],
          },
        })
        .expect(201);
      projectId = proj.body.id;

      const issue = await createIssue(booted.server, {
        projectId,
        title: "Schema-lifecycle issue",
        customFields: { severity: "S0" },
      });
      issueId = issue.id;
    });

    it("updates the project's customFieldSchema and persists the new shape", async () => {
      const updatedSchema = {
        fields: [
          { key: "severity", type: "enum", options: ["S0", "S1", "S2"] },
          { key: "customer", type: "string" },
        ],
      };
      await api
        .patch(`/projects/${projectId}`)
        .send({ customFieldSchema: updatedSchema })
        .expect(200);

      // GET round-trip is the authoritative check across dialects — see the
      // creation test for the rationale (PG save() omits JSON columns).
      const refetch = await api.get(`/projects/${projectId}`).expect(200);
      expect(parseCustomFields(refetch.body.customFieldSchema)).toEqual(updatedSchema);
    });

    it("preserves existing issue.customFields verbatim after the schema update", async () => {
      // The schema change is descriptive metadata — already-stored customFields
      // must not be silently mutated when the schema grows new keys.
      const refetched = await api.get(`/issues/${issueId}`).expect(200);
      expect(parseCustomFields(refetched.body.customFields)).toEqual({
        severity: "S0",
      });
    });

    it("accepts a customFields value that uses a newly-declared schema key", async () => {
      const issue = await createIssue(booted.server, {
        projectId,
        title: "Uses the new schema field",
        customFields: { severity: "S2", customer: "BigCorp" },
      });
      const refetched = await api.get(`/issues/${issue.id}`).expect(200);
      expect(parseCustomFields(refetched.body.customFields)).toEqual({
        severity: "S2",
        customer: "BigCorp",
      });
    });
  });

  describe("Update name + description", () => {
    let projectId: number;

    beforeAll(async () => {
      const r = await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: "Patchable",
          key: freshKey(),
          description: "initial",
        })
        .expect(201);
      projectId = r.body.id;
    });

    it("patches name and description", async () => {
      const r = await api
        .patch(`/projects/${projectId}`)
        .send({ name: "Patched", description: "updated" })
        .expect(200);
      expect(r.body.name).toBe("Patched");
      expect(r.body.description).toBe("updated");
    });

    it("returns 404 when patching a nonexistent project", async () => {
      await api
        .patch(`/projects/9999999`)
        .send({ name: "ghost" })
        .expect(404);
    });
  });

  describe("List", () => {
    it("returns workspace-scoped projects via GET /projects?workspaceId=...", async () => {
      const r = await api
        .get("/projects")
        .query({ workspaceId: fx.workspaceId })
        .expect(200);
      expect(Array.isArray(r.body)).toBe(true);
      for (const project of r.body) {
        expect(project.workspaceId).toBe(fx.workspaceId);
      }
    });

    it("honors a limit query parameter", async () => {
      const r = await api
        .get("/projects")
        .query({ workspaceId: fx.workspaceId, limit: 2 })
        .expect(200);
      expect(r.body.length).toBeLessThanOrEqual(2);
    });
  });

  describe("Delete (hard delete)", () => {
    it("removes the project and follow-up GET returns 404", async () => {
      const created = await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: "To delete",
          key: freshKey(),
        })
        .expect(201);

      await api.delete(`/projects/${created.body.id}`).expect(204);
      await api.get(`/projects/${created.body.id}`).expect(404);
    });

    it("returns 404 when deleting a nonexistent project", async () => {
      await api.delete(`/projects/9999999`).expect(404);
    });
  });
});
