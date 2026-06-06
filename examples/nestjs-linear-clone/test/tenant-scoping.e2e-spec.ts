// 127.0.0.1 is allowlisted so the SSRF guard permits the loopback webhook
// targets the cross-tenant tests register below — only endpoint CRUD *scoping*
// is exercised here, deliveries are never driven.
process.env.WEBHOOK_ALLOWED_HOSTS = "127.0.0.1";
process.env.WEBHOOK_ALLOW_HTTP = "true";

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
 * Cross-tenant authorization regression suite (#355, #356, #357).
 *
 * Builds two independent workspaces (acme, globex) and asserts that a member
 * of one cannot read or mutate the other's Comments / flat Work-logs / Bulk
 * edits / Issue lists, and that membership role changes are gated by role and
 * the last-owner invariant.
 */
integrationDescribe("[E2E] Cross-tenant scoping (#355/#356/#357)", () => {
  let booted: BootedApp;
  let acme: BaseFixture;
  let globex: BaseFixture;
  let aliceApi: ReturnType<typeof authedAgent>; // acme OWNER
  let bobApi: ReturnType<typeof authedAgent>; // acme MEMBER
  let globexApi: ReturnType<typeof authedAgent>; // globex OWNER

  // globex resources alice must never reach
  let globexIssueId: number;
  let globexCommentId: number;
  let globexWorkLogId: number;
  let globexOwnerMembershipId: number;

  // acme resources for positive paths + role tests
  let acmeIssueId: number;
  let aliceMembershipId: number;
  let bobMembershipId: number;
  let chrisMembershipId: number;

  async function membershipIdOf(
    api: ReturnType<typeof authedAgent>,
    workspaceId: number,
    userId: number,
  ): Promise<number> {
    const res = await api.get("/memberships").query({ workspaceId }).expect(200);
    const rows = res.body as Array<{
      id: number;
      userId?: number;
      user?: { id?: number };
    }>;
    const row = rows.find((r) => r.userId === userId || r.user?.id === userId);
    if (!row) {
      throw new Error(`no membership for user ${userId} in workspace ${workspaceId}`);
    }
    return row.id;
  }

  beforeAll(async () => {
    booted = await bootApp();
    acme = await createBaseFixture(booted.server);
    globex = await createBaseFixture(booted.server);

    aliceApi = authedAgent(booted.server, acme.ownerToken);
    bobApi = authedAgent(booted.server, acme.userTokens[1]);
    globexApi = authedAgent(booted.server, globex.ownerToken);

    // globex resources
    const gIssue = await createIssue(
      booted.server,
      { projectId: globex.projectId, title: "globex secret", status: "BACKLOG" },
      globex.ownerToken,
    );
    globexIssueId = gIssue.id;

    const gComment = await globexApi
      .post("/comments")
      .send({ issueId: globexIssueId, body: "globex internal note" })
      .expect(201);
    globexCommentId = gComment.body.id;

    const gWorkLog = await globexApi
      .post(`/issues/${globexIssueId}/work-logs`)
      .send({ hours: 2 })
      .expect(201);
    globexWorkLogId = gWorkLog.body.id;

    globexOwnerMembershipId = await membershipIdOf(
      globexApi,
      globex.workspaceId,
      globex.ownerId,
    );

    // acme resources
    const aIssue = await createIssue(
      booted.server,
      { projectId: acme.projectId, title: "acme work", status: "BACKLOG" },
      acme.ownerToken,
    );
    acmeIssueId = aIssue.id;

    aliceMembershipId = await membershipIdOf(
      aliceApi,
      acme.workspaceId,
      acme.userIds[0],
    );
    bobMembershipId = await membershipIdOf(
      aliceApi,
      acme.workspaceId,
      acme.userIds[1],
    );
    chrisMembershipId = await membershipIdOf(
      aliceApi,
      acme.workspaceId,
      acme.userIds[2],
    );
  }, 120000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30000);

  // ── #355 Comments ─────────────────────────────────────────────
  describe("#355 Comments are workspace-scoped", () => {
    it("alice can CRUD a comment on her own issue", async () => {
      const created = await aliceApi
        .post("/comments")
        .send({ issueId: acmeIssueId, body: "acme comment" })
        .expect(201);
      const id = created.body.id;

      await aliceApi.get("/comments").query({ issueId: acmeIssueId }).expect(200);
      await aliceApi.patch(`/comments/${id}`).send({ body: "edited" }).expect(200);
      await aliceApi.delete(`/comments/${id}`).expect(204);
    });

    it("alice cannot read globex's comment thread/revisions/reactions", async () => {
      await aliceApi.get(`/comments/${globexCommentId}/thread`).expect(403);
      await aliceApi.get(`/comments/${globexCommentId}/revisions`).expect(403);
      await aliceApi.get(`/comments/${globexCommentId}/reactions`).expect(403);
    });

    it("alice cannot list comments on a globex issue", async () => {
      await aliceApi.get("/comments").query({ issueId: globexIssueId }).expect(403);
      await aliceApi
        .get("/comments/cursor")
        .query({ issueId: globexIssueId })
        .expect(403);
    });

    it("alice cannot edit or delete a globex comment", async () => {
      await aliceApi
        .patch(`/comments/${globexCommentId}`)
        .send({ body: "hijack" })
        .expect(403);
      await aliceApi.delete(`/comments/${globexCommentId}`).expect(403);
    });

    it("alice cannot comment on a globex issue", async () => {
      await aliceApi
        .post("/comments")
        .send({ issueId: globexIssueId, body: "intruder" })
        .expect(403);
    });
  });

  // ── #355 flat Work-logs ───────────────────────────────────────
  describe("#355 flat Work-log routes are workspace-scoped", () => {
    it("alice cannot read/update/delete a globex work-log", async () => {
      await aliceApi.get(`/work-logs/${globexWorkLogId}`).expect(403);
      await aliceApi
        .patch(`/work-logs/${globexWorkLogId}`)
        .send({ hours: 999 })
        .expect(403);
      await aliceApi.delete(`/work-logs/${globexWorkLogId}`).expect(403);
    });

    it("alice can update her own work-log", async () => {
      const wl = await aliceApi
        .post(`/issues/${acmeIssueId}/work-logs`)
        .send({ hours: 1 })
        .expect(201);
      await aliceApi
        .patch(`/work-logs/${wl.body.id}`)
        .send({ hours: 3 })
        .expect(200);
    });
  });

  // ── #355 Bulk ─────────────────────────────────────────────────
  describe("#355 Bulk edit cannot cross tenants", () => {
    it("alice bulk-editing a globex issue id is rejected with 403", async () => {
      await aliceApi
        .post("/issues/bulk")
        .send({
          ids: [globexIssueId],
          expectedVersions: [1],
          patch: { priority: 4, title: "x" },
        })
        .expect(403);
    });

    it("a globex issue is not mutated by the rejected bulk request", async () => {
      const after = await globexApi.get(`/issues/${globexIssueId}`).expect(200);
      expect(after.body.title).toBe("globex secret");
    });

    it("alice can bulk-edit her own issue (non-status patch)", async () => {
      const own = await createIssue(
        booted.server,
        { projectId: acme.projectId, title: "bulk own", status: "BACKLOG", priority: 1 },
        acme.ownerToken,
      );
      const res = await aliceApi
        .post("/issues/bulk")
        .send({
          ids: [own.id],
          expectedVersions: [own.version],
          patch: { priority: 5, title: "bulk own edited" },
        })
        .expect(201);
      expect(res.body.summary.ok).toBe(1);
    });
  });

  // ── #357 Issue list / cursor ──────────────────────────────────
  describe("#357 Issue list/cursor are workspace-scoped + bounded", () => {
    it("GET /issues with a foreign projectId → 403", async () => {
      await aliceApi.get("/issues").query({ projectId: globex.projectId }).expect(403);
    });

    it("GET /issues with no projectId → 403 (fail closed, not an unbounded dump)", async () => {
      await aliceApi.get("/issues").expect(403);
    });

    it("GET /issues for her own project → 200", async () => {
      const res = await aliceApi
        .get("/issues")
        .query({ projectId: acme.projectId })
        .expect(200);
      const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
      expect(ids).not.toContain(globexIssueId);
    });

    it("GET /issues/cursor with a foreign projectId → 403", async () => {
      await aliceApi
        .get("/issues/cursor")
        .query({ projectId: globex.projectId })
        .expect(403);
    });

    it("GET /issues/cursor with no projectId → 403", async () => {
      await aliceApi.get("/issues/cursor").expect(403);
    });

    it("GET /issues/cursor for her own project → 200", async () => {
      const res = await aliceApi
        .get("/issues/cursor")
        .query({ projectId: acme.projectId, take: 5 })
        .expect(200);
      expect(res.body).toHaveProperty("data");
    });
  });

  // ── #356 Membership role change / revoke ──────────────────────
  describe("#356 Membership role-change / revoke is gated", () => {
    it("alice (acme OWNER) cannot touch a globex membership → 403", async () => {
      await aliceApi
        .patch(`/memberships/${globexOwnerMembershipId}/role`)
        .send({ role: "MEMBER" })
        .expect(403);
      await aliceApi.delete(`/memberships/${globexOwnerMembershipId}`).expect(403);
    });

    it("bob (acme MEMBER) cannot change another member's role → 403", async () => {
      await bobApi
        .patch(`/memberships/${aliceMembershipId}/role`)
        .send({ role: "GUEST" })
        .expect(403);
    });

    it("bob (acme MEMBER) cannot self-promote to OWNER → 403", async () => {
      await bobApi
        .patch(`/memberships/${bobMembershipId}/role`)
        .send({ role: "OWNER" })
        .expect(403);
    });

    it("the last OWNER cannot be demoted → 409", async () => {
      await aliceApi
        .patch(`/memberships/${aliceMembershipId}/role`)
        .send({ role: "MEMBER" })
        .expect(409);
    });

    it("the last OWNER cannot be revoked → 409", async () => {
      await aliceApi.delete(`/memberships/${aliceMembershipId}`).expect(409);
    });

    it("an OWNER can promote a member to ADMIN, and the ADMIN can then change roles", async () => {
      await aliceApi
        .patch(`/memberships/${bobMembershipId}/role`)
        .send({ role: "ADMIN" })
        .expect(200);

      // bob is now ADMIN → may change chris's role
      await bobApi
        .patch(`/memberships/${chrisMembershipId}/role`)
        .send({ role: "GUEST" })
        .expect(200);
    });
  });

  // ── Issue links cannot cross tenants (IDOR write + closure read leak) ──
  describe("Issue links are workspace-scoped", () => {
    it("alice cannot link her issue to a globex issue (blocks) → 404", async () => {
      await aliceApi
        .post(`/issues/${acmeIssueId}/links`)
        .send({ targetId: globexIssueId, type: "blocks" })
        .expect(404);
    });

    it("the blockedBy orientation is rejected too → 404", async () => {
      await aliceApi
        .post(`/issues/${acmeIssueId}/links`)
        .send({ targetId: globexIssueId, type: "blockedBy" })
        .expect(404);
    });

    it("the globex issue never leaks through the dependents closure", async () => {
      const dep = await aliceApi
        .get(`/issues/${acmeIssueId}/dependents`)
        .expect(200);
      const ids = (dep.body as Array<{ id: number }>).map((r) => r.id);
      expect(ids).not.toContain(globexIssueId);
    });

    it("alice can still link two of her own (same-workspace) issues → 201", async () => {
      const target = await createIssue(
        booted.server,
        {
          projectId: acme.projectId,
          title: "same-ws link target",
          status: "BACKLOG",
        },
        acme.ownerToken,
      );
      await aliceApi
        .post(`/issues/${acmeIssueId}/links`)
        .send({ targetId: target.id, type: "relatesTo" })
        .expect(201);
    });
  });

  // ── @mention notifications cannot cross tenants ───────────────
  describe("@mention notifications are workspace-scoped", () => {
    let acmeBobHandle: string;
    let globexOwnerHandle: string;

    beforeAll(async () => {
      // `/users` is global; map id → email local-part (the mention handle).
      const usersRes = await aliceApi
        .get("/users")
        .query({ limit: 100 })
        .expect(200);
      const handleOf = new Map<number, string>(
        (usersRes.body as Array<{ id: number; email: string }>).map((u) => [
          u.id,
          u.email.split("@")[0],
        ]),
      );
      acmeBobHandle = handleOf.get(acme.userIds[1])!;
      globexOwnerHandle = handleOf.get(globex.ownerId)!;
    });

    it("an acme comment pings a mentioned acme member but never a globex-only user", async () => {
      await aliceApi
        .post("/comments")
        .send({
          issueId: acmeIssueId,
          body: `@${acmeBobHandle} and @${globexOwnerHandle} please look`,
        })
        .expect(201);

      // In-workspace mention reaches acme bob.
      const bobInbox = await bobApi.get("/inbox").expect(200);
      const bobMentions = bobInbox.body.data.filter(
        (n: { kind: string; sourceIssueId: number }) =>
          n.kind === "mention" && n.sourceIssueId === acmeIssueId,
      );
      expect(bobMentions.length).toBe(1);

      // The globex owner — not a member of acme — must receive nothing.
      const globexInbox = await globexApi.get("/inbox").expect(200);
      const leaked = globexInbox.body.data.filter(
        (n: { kind: string; sourceIssueId: number }) =>
          n.kind === "mention" && n.sourceIssueId === acmeIssueId,
      );
      expect(leaked.length).toBe(0);
    });
  });

  // ── Remaining cross-tenant + authorization holes (webhooks / saved-filters
  //    / search / analytics / queue / attachments / users / memberships) ─────
  describe("Remaining cross-tenant + authorization holes are closed", () => {
    let globexEndpointId: number;
    let acmeFilterId: number;
    let globexFilterId: number;
    let globexSprintId: number;
    let globexAttachmentId: number;
    let danaApi: ReturnType<typeof authedAgent>; // acme MEMBER, untouched by #356

    beforeAll(async () => {
      danaApi = authedAgent(booted.server, acme.userTokens[3]);

      const gEp = await globexApi
        .post("/webhooks/endpoints")
        .send({
          workspaceId: globex.workspaceId,
          url: "http://127.0.0.1/globex-hook",
          secret: "globex-webhook-secret-1234",
          events: ["issue.updated"],
        })
        .expect(201);
      globexEndpointId = gEp.body.id;

      const gf = await globexApi
        .post("/saved-filters")
        .send({
          workspaceId: globex.workspaceId,
          name: "globex backlog",
          definition: { field: "status", op: "eq", value: "BACKLOG" },
        })
        .expect(201);
      globexFilterId = gf.body.id;
      const af = await aliceApi
        .post("/saved-filters")
        .send({
          workspaceId: acme.workspaceId,
          name: "acme backlog",
          definition: { field: "status", op: "eq", value: "BACKLOG" },
        })
        .expect(201);
      acmeFilterId = af.body.id;

      globexSprintId = await createSprint(
        booted.server,
        globex.projectId,
        7,
        globex.ownerToken,
      );
      const ga = await globexApi
        .post(`/issues/${globexIssueId}/attachments`)
        .send({
          filename: "globex-secret.pdf",
          contentType: "application/pdf",
          sizeBytes: 42,
          storageUrl: "s3://globex/secret.pdf",
        })
        .expect(201);
      globexAttachmentId = ga.body.id;
    }, 60000);

    it("webhook endpoint responses never serialize the signing secret", async () => {
      const created = await globexApi
        .post("/webhooks/endpoints")
        .send({
          workspaceId: globex.workspaceId,
          url: "http://127.0.0.1/globex-hook-2",
          secret: "another-secret-12345678",
          events: ["issue.updated"],
        })
        .expect(201);
      expect(created.body.secret).toBeUndefined();

      const fetched = await globexApi
        .get(`/webhooks/endpoints/${created.body.id}`)
        .expect(200);
      expect(fetched.body.secret).toBeUndefined();
    });

    it("alice cannot read or delete a globex webhook endpoint → 403", async () => {
      await aliceApi.get(`/webhooks/endpoints/${globexEndpointId}`).expect(403);
      await aliceApi.delete(`/webhooks/endpoints/${globexEndpointId}`).expect(403);
    });

    it("alice cannot read, run, or delete a globex saved filter → 403", async () => {
      await aliceApi.get(`/saved-filters/${globexFilterId}`).expect(403);
      await aliceApi.get(`/saved-filters/${globexFilterId}/run`).expect(403);
      await aliceApi.delete(`/saved-filters/${globexFilterId}`).expect(403);
    });

    it("GET /saved-filters lists only the caller's own workspaces", async () => {
      const res = await aliceApi.get("/saved-filters").expect(200);
      const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
      expect(ids).toContain(acmeFilterId);
      expect(ids).not.toContain(globexFilterId);
    });

    it("running an acme saved filter never returns globex issues", async () => {
      const res = await aliceApi
        .get(`/saved-filters/${acmeFilterId}/run`)
        .expect(200);
      const ids = (res.body.data as Array<{ id: number }>).map((r) => r.id);
      expect(ids).not.toContain(globexIssueId);
    });

    it("alice cannot full-text search a globex project → 403", async () => {
      await aliceApi
        .get("/search/issues")
        .query({ q: "secret", projectId: globex.projectId })
        .expect(403);
    });

    it("alice can full-text search her own project → 200", async () => {
      await aliceApi
        .get("/search/issues")
        .query({ q: "acme", projectId: acme.projectId })
        .expect(200);
    });

    it("alice cannot read a globex sprint burndown → 403", async () => {
      await aliceApi
        .get(`/analytics/sprints/${globexSprintId}/burndown`)
        .expect(403);
    });

    it("alice cannot claim or stat a globex project queue → 403", async () => {
      await aliceApi
        .post("/queue/claim")
        .send({ workerId: "intruder", projectId: globex.projectId })
        .expect(403);
      await aliceApi.get(`/queue/stats/${globex.projectId}`).expect(403);
    });

    it("alice cannot read or delete a globex attachment → 403", async () => {
      await aliceApi.get(`/attachments/${globexAttachmentId}`).expect(403);
      await aliceApi.delete(`/attachments/${globexAttachmentId}`).expect(403);
    });

    it("alice cannot list or attach to a globex comment → 403", async () => {
      await aliceApi.get(`/comments/${globexCommentId}/attachments`).expect(403);
      await aliceApi
        .post(`/comments/${globexCommentId}/attachments`)
        .send({
          filename: "x.pdf",
          contentType: "application/pdf",
          sizeBytes: 1,
          storageUrl: "s3://x/x.pdf",
        })
        .expect(403);
    });

    it("alice cannot modify or delete another user's account → 403", async () => {
      await aliceApi
        .patch(`/users/${acme.userIds[1]}`)
        .send({ name: "hijacked" })
        .expect(403);
      await aliceApi.delete(`/users/${globex.ownerId}`).expect(403);
    });

    it("alice can update her own profile → 200", async () => {
      await aliceApi
        .patch(`/users/${acme.ownerId}`)
        .send({ name: "Alice Updated" })
        .expect(200);
    });

    it("alice cannot enumerate a globex roster or another user's memberships → 403", async () => {
      await aliceApi
        .get("/memberships")
        .query({ workspaceId: globex.workspaceId })
        .expect(403);
      await aliceApi
        .get("/memberships")
        .query({ userId: globex.ownerId })
        .expect(403);
    });

    it("a plain acme MEMBER cannot invite anyone as OWNER (privilege escalation) → 403", async () => {
      const suffix = `sock${Date.now().toString(36)}`;
      const reg = await aliceApi
        .post("/auth/register")
        .send({
          email: `${suffix}@acme.test`,
          name: suffix,
          password: "fixture-password-123",
        })
        .expect(201);
      const sockId = reg.body.user.id as number;

      await danaApi
        .post("/memberships")
        .send({ workspaceId: acme.workspaceId, userId: sockId, role: "OWNER" })
        .expect(403);
    });
  });
});
