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

integrationDescribe(
  "[E2E] Comments — threading, reactions, edit history",
  () => {
    let booted: BootedApp;
    let fx: BaseFixture;
    let owner: ReturnType<typeof authedAgent>;
    let memberB: ReturnType<typeof authedAgent>;
    let issueId: number;

    beforeAll(async () => {
      booted = await bootApp();
      fx = await createBaseFixture(booted.server);
      owner = authedAgent(booted.server, fx.ownerToken);
      memberB = authedAgent(booted.server, fx.userTokens[1]);

      const issue = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Threading subject",
      });
      issueId = issue.id;
    }, 60000);

    afterAll(async () => {
      await shutdownApp(booted);
    }, 30000);

    // ────────────────────────────────────────────────
    // Recursive thread fetch
    // ────────────────────────────────────────────────
    describe("Recursive thread (parent_comment_id walk)", () => {
      let rootId: number;
      let replyAId: number;
      let replyBId: number;

      it("creates root R, reply A under R, reply B under A", async () => {
        const root = await owner
          .post("/comments")
          .send({ issueId, body: "R: top-level question" })
          .expect(201);
        rootId = root.body.id;
        expect(root.body.parentCommentId).toBeFalsy();

        const replyA = await owner
          .post("/comments")
          .send({
            issueId,
            body: "A: reply to R",
            parentCommentId: rootId,
          })
          .expect(201);
        replyAId = replyA.body.id;
        expect(Number(replyA.body.parentCommentId)).toBe(rootId);

        const replyB = await owner
          .post("/comments")
          .send({
            issueId,
            body: "B: reply to A",
            parentCommentId: replyAId,
          })
          .expect(201);
        replyBId = replyB.body.id;
        expect(Number(replyB.body.parentCommentId)).toBe(replyAId);
      });

      it("/comments/:id/thread returns 3 nodes ordered by path/depth", async () => {
        const res = await owner
          .get(`/comments/${rootId}/thread`)
          .expect(200);

        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBe(3);

        const [n0, n1, n2] = res.body;
        expect(n0.id).toBe(rootId);
        expect(n0.depth).toBe(0);
        expect(n0.parentCommentId).toBeNull();

        expect(n1.id).toBe(replyAId);
        expect(n1.depth).toBe(1);
        expect(Number(n1.parentCommentId)).toBe(rootId);

        expect(n2.id).toBe(replyBId);
        expect(n2.depth).toBe(2);
        expect(Number(n2.parentCommentId)).toBe(replyAId);

        // Path is monotonically extended down the chain.
        expect(n1.path.startsWith(n0.path + "/")).toBe(true);
        expect(n2.path.startsWith(n1.path + "/")).toBe(true);
      });

      it("rejects parentCommentId pointing at a different issue", async () => {
        const otherIssue = await createIssue(booted.server, {
          projectId: fx.projectId,
          title: "Other issue for cross-issue parent test",
        });
        await owner
          .post("/comments")
          .send({
            issueId: otherIssue.id,
            body: "Should be rejected — parent lives on a different issue",
            parentCommentId: rootId,
          })
          .expect(404);
      });

      it("/comments/:id/thread returns 404 for an unknown comment id", async () => {
        await owner.get("/comments/9999999/thread").expect(404);
      });
    });

    // ────────────────────────────────────────────────
    // Reactions — composite-PK idempotence
    // ────────────────────────────────────────────────
    describe("Reactions", () => {
      let commentId: number;

      beforeAll(async () => {
        const r = await owner
          .post("/comments")
          .send({ issueId, body: "Reaction subject" })
          .expect(201);
        commentId = r.body.id;
      });

      it("posting the same reaction twice is idempotent (count stays 1)", async () => {
        await owner
          .post(`/comments/${commentId}/reactions`)
          .send({ emoji: "thumbsup" })
          .expect(201);
        await owner
          .post(`/comments/${commentId}/reactions`)
          .send({ emoji: "thumbsup" })
          .expect(201);

        const list = await owner
          .get(`/comments/${commentId}/reactions`)
          .expect(200);
        const entry = list.body.find((r: any) => r.emoji === "thumbsup");
        expect(entry).toBeTruthy();
        expect(Number(entry.count)).toBe(1);
        expect(entry.userIds).toEqual([fx.ownerId]);
      });

      it("two users reacting with the same emoji aggregates to count=2", async () => {
        await memberB
          .post(`/comments/${commentId}/reactions`)
          .send({ emoji: "thumbsup" })
          .expect(201);

        const list = await owner
          .get(`/comments/${commentId}/reactions`)
          .expect(200);
        const entry = list.body.find((r: any) => r.emoji === "thumbsup");
        expect(entry).toBeTruthy();
        expect(Number(entry.count)).toBe(2);
        expect(entry.userIds.sort((a: number, b: number) => a - b)).toEqual(
          [fx.ownerId, fx.userIds[1]].sort((a, b) => a - b),
        );
      });

      it("a different emoji surfaces as a separate group", async () => {
        await owner
          .post(`/comments/${commentId}/reactions`)
          .send({ emoji: "rocket" })
          .expect(201);

        const list = await owner
          .get(`/comments/${commentId}/reactions`)
          .expect(200);
        const emojis = list.body.map((r: any) => r.emoji);
        expect(emojis).toEqual(expect.arrayContaining(["thumbsup", "rocket"]));
      });

      it("DELETE only removes the calling user's reaction", async () => {
        await owner
          .delete(`/comments/${commentId}/reactions/thumbsup`)
          .expect(204);

        const list = await owner
          .get(`/comments/${commentId}/reactions`)
          .expect(200);
        const entry = list.body.find((r: any) => r.emoji === "thumbsup");
        // memberB's reaction must survive since they didn't call DELETE.
        expect(entry).toBeTruthy();
        expect(Number(entry.count)).toBe(1);
        expect(entry.userIds).toEqual([fx.userIds[1]]);
      });

      it("removing a non-existent reaction is a 204 no-op", async () => {
        await owner
          .delete(`/comments/${commentId}/reactions/never-reacted`)
          .expect(204);
      });
    });

    // ────────────────────────────────────────────────
    // Edit history — append-only revisions
    // ────────────────────────────────────────────────
    describe("Edit history", () => {
      let commentId: number;

      beforeAll(async () => {
        const r = await owner
          .post("/comments")
          .send({ issueId, body: "v1: original" })
          .expect(201);
        commentId = r.body.id;
      });

      it("first edit snapshots v1; live row carries v2", async () => {
        const updated = await owner
          .patch(`/comments/${commentId}`)
          .send({ body: "v2: first edit" })
          .expect(200);
        expect(updated.body.body).toBe("v2: first edit");

        const revs = await owner
          .get(`/comments/${commentId}/revisions`)
          .expect(200);
        expect(revs.body.length).toBe(1);
        expect(revs.body[0].body).toBe("v1: original");
        expect(Number(revs.body[0].editorId)).toBe(fx.ownerId);
      });

      it("second edit snapshots v2 and revisions list is chronological", async () => {
        const updated = await owner
          .patch(`/comments/${commentId}`)
          .send({ body: "v3: second edit" })
          .expect(200);
        expect(updated.body.body).toBe("v3: second edit");

        const revs = await owner
          .get(`/comments/${commentId}/revisions`)
          .expect(200);
        expect(revs.body.length).toBe(2);
        expect(revs.body.map((r: any) => r.body)).toEqual([
          "v1: original",
          "v2: first edit",
        ]);
      });

      it("editor on each revision is the calling user (not the original author)", async () => {
        // memberB edits the same comment owner created.
        await memberB
          .patch(`/comments/${commentId}`)
          .send({ body: "v4: edit by memberB" })
          .expect(200);

        const revs = await owner
          .get(`/comments/${commentId}/revisions`)
          .expect(200);
        expect(revs.body.length).toBe(3);
        const last = revs.body[revs.body.length - 1];
        expect(last.body).toBe("v3: second edit");
        expect(Number(last.editorId)).toBe(fx.userIds[1]);
      });
    });

    // ────────────────────────────────────────────────
    // Regression — flat comments flow still works
    // ────────────────────────────────────────────────
    describe("Existing comments flow still passes", () => {
      it("plain comment with no parentCommentId behaves as before", async () => {
        const r = await owner
          .post("/comments")
          .send({ issueId, body: "flat comment, no parent" })
          .expect(201);
        expect(r.body.parentCommentId).toBeFalsy();

        const list = await owner
          .get(`/comments`)
          .query({ issueId })
          .expect(200);
        expect(Array.isArray(list.body)).toBe(true);
        expect(list.body.find((c: any) => c.id === r.body.id)).toBeTruthy();
      });
    });
  },
);
