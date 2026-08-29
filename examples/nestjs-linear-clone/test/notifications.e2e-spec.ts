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
 * Watchers + @mentions + status-change fan-out. The fixture mints four users
 * (alice, bob, chris, dana). We use:
 *   - alice (userIds[0]) as the actor — opens the issue, comments, edits
 *   - bob   (userIds[1]) as the watcher — should get status-change pings
 *   - chris (userIds[2]) as the mention target — should get @mention pings
 *
 * Each fixture user's email is `<handle>-<suffix>@acme.test`; the mention
 * parser captures handles up to 32 chars and the subscriber matches against
 * `email.split("@")[0]` so `@alice-<suffix>` resolves correctly.
 */
integrationDescribe("[E2E] Notifications — watchers, @mentions, status-change fan-out", () => {
  let booted: BootedApp;
  let fx: BaseFixture;
  let alice: ReturnType<typeof authedAgent>;
  let bob: ReturnType<typeof authedAgent>;
  let chris: ReturnType<typeof authedAgent>;
  let issueId: number;
  let issueVersion: number;
  let aliceHandle: string;
  let bobHandle: string;
  let chrisHandle: string;

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
    alice = authedAgent(booted.server, fx.userTokens[0]);
    bob = authedAgent(booted.server, fx.userTokens[1]);
    chris = authedAgent(booted.server, fx.userTokens[2]);

    // Handles come straight from the fixture (register response), never from
    // GET /users — that page returns the oldest 100 rows, so on a shared DB
    // with accumulated fixture users the freshly created users fell off the
    // page and every mention body became `@undefined`.
    aliceHandle = fx.userHandles[0];
    bobHandle = fx.userHandles[1];
    chrisHandle = fx.userHandles[2];

    const r = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "Notifications subject issue",
      status: "BACKLOG",
      priority: 2,
    });
    issueId = r.id;
    issueVersion = r.version;
  }, 60_000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30_000);

  // ────────────────────────────────────────────────
  // Watchers
  // ────────────────────────────────────────────────
  describe("Watchers", () => {
    it("bob watches the issue → 201", async () => {
      await bob.post(`/issues/${issueId}/watch`).expect(201);
    });

    it("watch is idempotent (POSTing again returns the same row)", async () => {
      const a = await bob.post(`/issues/${issueId}/watch`).expect(201);
      const list = await alice.get(`/issues/${issueId}/watchers`).expect(200);
      const bobRows = list.body.filter(
        (w: { userId: number }) => w.userId === fx.userIds[1],
      );
      expect(bobRows.length).toBe(1);
      expect(a.body.id).toBe(bobRows[0].id);
    });

    it("non-watcher (chris) is not in the watcher list", async () => {
      const list = await alice.get(`/issues/${issueId}/watchers`).expect(200);
      const chrisRows = list.body.filter(
        (w: { userId: number }) => w.userId === fx.userIds[2],
      );
      expect(chrisRows.length).toBe(0);
    });
  });

  // ────────────────────────────────────────────────
  // Mentions via Comment.afterInsert
  // ────────────────────────────────────────────────
  describe("@mention notifications", () => {
    it("alice posts a comment mentioning chris → chris's inbox has a `mention`", async () => {
      await alice
        .post("/comments")
        .send({
          issueId,
          body: `@${chrisHandle} please review when you can`,
        })
        .expect(201);

      const inbox = await chris.get("/inbox").expect(200);
      const mentions = inbox.body.data.filter(
        (n: { kind: string; sourceIssueId: number }) =>
          n.kind === "mention" && n.sourceIssueId === issueId,
      );
      expect(mentions.length).toBe(1);
    });

    it("the actor never notifies themselves on a self-mention", async () => {
      await alice
        .post("/comments")
        .send({
          issueId,
          body: `Note from @${aliceHandle} — self-tag`,
        })
        .expect(201);

      const inbox = await alice.get("/inbox").expect(200);
      expect(inbox.body.data).toEqual([]);
    });

    it("dedupes repeated mentions in a single comment", async () => {
      const before = await chris.get("/inbox").expect(200);
      const beforeMentions = before.body.data.filter(
        (n: { kind: string }) => n.kind === "mention",
      ).length;

      await alice
        .post("/comments")
        .send({
          issueId,
          body: `Hey @${chrisHandle} and @${chrisHandle} — same person`,
        })
        .expect(201);

      const after = await chris.get("/inbox").expect(200);
      const afterMentions = after.body.data.filter(
        (n: { kind: string }) => n.kind === "mention",
      ).length;
      expect(afterMentions - beforeMentions).toBe(1);
    });
  });

  // ────────────────────────────────────────────────
  // Status-change fan-out via Issue.beforeUpdate (databaseEntity diff)
  // ────────────────────────────────────────────────
  describe("Status-change fan-out", () => {
    it("status BACKLOG → TODO pings every watcher (bob)", async () => {
      // BACKLOG → TODO is the first valid step in the default workflow chain.
      const fresh = await alice.get(`/issues/${issueId}`).expect(200);
      issueVersion = fresh.body.version;

      await alice
        .patch(`/issues/${issueId}`)
        .send({ expectedVersion: issueVersion, status: "TODO" })
        .expect(200);

      const inbox = await bob.get("/inbox").expect(200);
      const statusChanges = inbox.body.data.filter(
        (n: { kind: string; sourceIssueId: number; payload: any }) =>
          n.kind === "status_change" &&
          n.sourceIssueId === issueId &&
          n.payload?.from === "BACKLOG" &&
          n.payload?.to === "TODO",
      );
      expect(statusChanges.length).toBe(1);
    });

    it("status_change does NOT reach a non-watcher (chris)", async () => {
      const inbox = await chris.get("/inbox").expect(200);
      const statusChanges = inbox.body.data.filter(
        (n: { kind: string; sourceIssueId: number }) =>
          n.kind === "status_change" && n.sourceIssueId === issueId,
      );
      expect(statusChanges.length).toBe(0);
    });

    it("the actor (alice) never notifies herself on her own status edit", async () => {
      const inbox = await alice.get("/inbox").expect(200);
      expect(inbox.body.data).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────
  // Read state
  // ────────────────────────────────────────────────
  describe("Inbox read state", () => {
    it("unread-count drops by 1 after marking a notification read", async () => {
      const initial = await chris.get("/inbox/unread-count").expect(200);
      expect(initial.body.count).toBeGreaterThan(0);

      const inbox = await chris.get("/inbox").expect(200);
      const target = inbox.body.data[0];
      const marked = await chris
        .patch(`/inbox/${target.id}/read`)
        .expect(200);
      expect(marked.body.readAt).toBeTruthy();

      const after = await chris.get("/inbox/unread-count").expect(200);
      expect(after.body.count).toBe(initial.body.count - 1);
    });

    it("read-all zeroes the unread count", async () => {
      const r = await chris.patch("/inbox-read-all").expect(200);
      expect(r.body.marked).toBeGreaterThanOrEqual(0);

      const after = await chris.get("/inbox/unread-count").expect(200);
      expect(after.body.count).toBe(0);
    });

    it("marking another user's notification → 404", async () => {
      // Fan-out one more notification onto chris's inbox so we have a row
      // belonging to someone else.
      await alice
        .post("/comments")
        .send({
          issueId,
          body: `@${chrisHandle} fresh ping`,
        })
        .expect(201);
      const chrisInbox = await chris.get("/inbox").expect(200);
      const chrisOwned = chrisInbox.body.data[0];

      // bob tries to mark chris's notification as read.
      await bob.patch(`/inbox/${chrisOwned.id}/read`).expect(404);
    });
  });

  // ────────────────────────────────────────────────
  // Unwatch
  // ────────────────────────────────────────────────
  describe("Unwatch", () => {
    it("after unwatch, status-change no longer pings the (former) watcher", async () => {
      await bob.delete(`/issues/${issueId}/watch`).expect(204);

      // Walk the workflow forward; the issue is at TODO from the
      // earlier "status BACKLOG → TODO" test. TODO → IN_PROGRESS is the
      // next valid step.
      const fresh = await alice.get(`/issues/${issueId}`).expect(200);
      const v = fresh.body.version;

      await alice
        .patch(`/issues/${issueId}`)
        .send({ expectedVersion: v, status: "IN_PROGRESS" })
        .expect(200);

      const inbox = await bob.get("/inbox").expect(200);
      const newStatusChanges = inbox.body.data.filter(
        (n: { kind: string; sourceIssueId: number; payload: any }) =>
          n.kind === "status_change" &&
          n.sourceIssueId === issueId &&
          n.payload?.to === "IN_PROGRESS",
      );
      expect(newStatusChanges.length).toBe(0);
    });
  });
});
