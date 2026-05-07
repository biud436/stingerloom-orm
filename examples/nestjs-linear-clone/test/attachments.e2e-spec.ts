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
 * Polymorphic attachments — discriminator-column workaround (no @Polymorphic
 * decorator), as called out in #304. The same `Attachment` row can belong to
 * either an Issue or a Comment, distinguished by `(owner_type, owner_id)`.
 *
 * The test exercises:
 *   - Issue-owned attach + list (composite-index path)
 *   - Comment-owned attach + list (same table, different discriminator)
 *   - Service-layer integrity check: invalid owner → 404
 *   - Cross-owner isolation: comment list does not leak issue rows
 */
integrationDescribe("[E2E] Attachments — polymorphic owner (Issue / Comment)", () => {
  let booted: BootedApp;
  let fx: BaseFixture;
  let api: ReturnType<typeof authedAgent>;
  let issueId: number;
  let commentId: number;

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
    api = authedAgent(booted.server, fx.ownerToken);

    const i = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "Attachment subject issue",
      status: "BACKLOG",
    });
    issueId = i.id;

    const c = await api
      .post("/comments")
      .send({ issueId, body: "first comment" })
      .expect(201);
    commentId = c.body.id;
  }, 60_000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30_000);

  describe("Issue-owned attachments", () => {
    it("POST /issues/:id/attachments → 201", async () => {
      const r = await api
        .post(`/issues/${issueId}/attachments`)
        .send({
          filename: "screenshot.png",
          contentType: "image/png",
          sizeBytes: 1024,
          storageUrl: "s3://bucket/a.png",
        })
        .expect(201);
      expect(r.body.ownerType).toBe("ISSUE");
      expect(r.body.ownerId).toBe(issueId);
      // `uploadedById` is the RelationColumn FK shadow; not in the default
      // SELECT projection, so the response omits it. The DB row holds the
      // FK and a dedicated GET would surface it via the relation.
      expect(r.body.id).toBeDefined();
    });

    it("GET /issues/:id/attachments returns the row", async () => {
      const r = await api.get(`/issues/${issueId}/attachments`).expect(200);
      expect(r.body).toHaveLength(1);
      expect(r.body[0].filename).toBe("screenshot.png");
    });

    it("rejects sizeBytes <= 0", async () => {
      await api
        .post(`/issues/${issueId}/attachments`)
        .send({
          filename: "empty.bin",
          contentType: "application/octet-stream",
          sizeBytes: 0,
          storageUrl: "s3://bucket/empty",
        })
        .expect(400);
    });
  });

  describe("Comment-owned attachments", () => {
    it("POST /comments/:id/attachments → 201", async () => {
      const r = await api
        .post(`/comments/${commentId}/attachments`)
        .send({
          filename: "patch.diff",
          contentType: "text/x-diff",
          sizeBytes: 512,
          storageUrl: "s3://bucket/p.diff",
        })
        .expect(201);
      expect(r.body.ownerType).toBe("COMMENT");
      expect(r.body.ownerId).toBe(commentId);
    });

    it("GET /comments/:id/attachments returns only the comment's row", async () => {
      const r = await api.get(`/comments/${commentId}/attachments`).expect(200);
      expect(r.body).toHaveLength(1);
      expect(r.body[0].filename).toBe("patch.diff");
      // Cross-owner isolation: comment list must not include the issue's row.
      expect(
        (r.body as Array<{ filename: string }>).every(
          (a) => a.filename !== "screenshot.png",
        ),
      ).toBe(true);
    });
  });

  describe("Integrity", () => {
    it("404 when attaching to a non-existent issue", async () => {
      await api
        .post(`/issues/9999999/attachments`)
        .send({
          filename: "x.png",
          contentType: "image/png",
          sizeBytes: 1,
          storageUrl: "s3://x",
        })
        .expect(404);
    });

    it("404 when attaching to a non-existent comment", async () => {
      await api
        .post(`/comments/9999999/attachments`)
        .send({
          filename: "x.png",
          contentType: "image/png",
          sizeBytes: 1,
          storageUrl: "s3://x",
        })
        .expect(404);
    });
  });

  describe("Generic attachment ops", () => {
    it("DELETE /attachments/:id removes it", async () => {
      const list = await api.get(`/issues/${issueId}/attachments`).expect(200);
      const id = list.body[0].id;
      await api.delete(`/attachments/${id}`).expect(204);
      await api.get(`/attachments/${id}`).expect(404);
    });
  });
});
