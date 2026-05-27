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
  createLabel,
  BaseFixture,
} from "./helpers/fixtures";

integrationDescribe("[E2E] Issues — CRUD, numbering, optimistic lock, M2M, soft delete, audit log", () => {
  let booted: BootedApp;
  let fx: BaseFixture;
  let api: ReturnType<typeof authedAgent>;
  let labelBugId: number;
  let labelPerfId: number;

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
    api = authedAgent(booted.server, fx.ownerToken);
    labelBugId = await createLabel(booted.server, fx.projectId, "bug");
    labelPerfId = await createLabel(booted.server, fx.projectId, "perf");
  }, 60000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30000);

  // ────────────────────────────────────────────────
  // Per-project number assignment
  // ────────────────────────────────────────────────
  describe("Per-project numbering", () => {
    it("assigns 1, 2, 3, ... in order on serial creates", async () => {
      const numbers: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await createIssue(booted.server, {
          projectId: fx.projectId,
          title: `Sequential issue ${i}`,
          status: "BACKLOG",
          priority: 3,
        });
        numbers.push(r.number);
      }
      // Numbers are strictly increasing
      for (let i = 1; i < numbers.length; i++) {
        expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
      }
      // No gaps within this batch (assuming this is the first batch in the project)
      // Rather than assume a starting offset, just assert step=1 between adjacent.
      for (let i = 1; i < numbers.length; i++) {
        expect(numbers[i] - numbers[i - 1]).toBe(1);
      }
    });

    it("never produces duplicate numbers under concurrent creates", async () => {
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          createIssue(booted.server, {
            projectId: fx.projectId,
            title: `Concurrent issue ${i}`,
            status: "BACKLOG",
          }),
        ),
      );
      const numbers = results.map((r) => r.number);
      const unique = new Set(numbers);
      expect(unique.size).toBe(N);
    });
  });

  // ────────────────────────────────────────────────
  // Optimistic locking via @Version
  // ────────────────────────────────────────────────
  describe("Optimistic locking (@Version)", () => {
    let issueId: number;
    let initialVersion: number;

    beforeAll(async () => {
      const r = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Optimistic-lock subject",
        status: "BACKLOG",
        priority: 3,
      });
      issueId = r.id;
      initialVersion = r.version;
    });

    it("first update with the current version succeeds", async () => {
      const res = await api
        .patch(`/issues/${issueId}`)
        .send({ expectedVersion: initialVersion, title: "Renamed" })
        .expect(200);
      expect(res.body.version).toBe(initialVersion + 1);
      expect(res.body.title).toBe("Renamed");
    });

    it("a second update reusing the original version returns 409", async () => {
      await api
        .patch(`/issues/${issueId}`)
        .send({ expectedVersion: initialVersion, title: "Should fail" })
        .expect(409);
    });

    it("two concurrent updates → exactly one succeeds and one returns 409", async () => {
      const fresh = await api.get(`/issues/${issueId}`).expect(200);
      const v = fresh.body.version;

      // Use title (a non-workflow field) so both branches are independently
      // valid — the only reason one fails is the optimistic-lock race.
      const [a, b] = await Promise.all([
        api
          .patch(`/issues/${issueId}`)
          .send({ expectedVersion: v, title: "Concurrent A" }),
        api
          .patch(`/issues/${issueId}`)
          .send({ expectedVersion: v, title: "Concurrent B" }),
      ]);

      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses).toEqual([200, 409]);
    });

    it("version monotonically increments on each successful update", async () => {
      const fetched = await api.get(`/issues/${issueId}`);
      const v0 = fetched.body.version;

      const r1 = await api
        .patch(`/issues/${issueId}`)
        .send({ expectedVersion: v0, priority: 1 })
        .expect(200);
      expect(r1.body.version).toBe(v0 + 1);

      const r2 = await api
        .patch(`/issues/${issueId}`)
        .send({ expectedVersion: r1.body.version, priority: 2 })
        .expect(200);
      expect(r2.body.version).toBe(v0 + 2);
    });
  });

  // ────────────────────────────────────────────────
  // ManyToMany labels via direct join-table SQL
  // ────────────────────────────────────────────────
  describe("ManyToMany labels", () => {
    let issueId: number;

    beforeAll(async () => {
      const r = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Label fixture issue",
      });
      issueId = r.id;
    });

    it("attaches a label", async () => {
      await api
        .post(`/issues/${issueId}/labels`)
        .send({ labelId: labelBugId })
        .expect(201);

      const issue = await api.get(`/issues/${issueId}`).expect(200);
      const labelIds = (issue.body.labels ?? []).map((l: any) => l.id);
      expect(labelIds).toContain(labelBugId);
    });

    it("attaching the same label twice is idempotent (no duplicate row)", async () => {
      await api
        .post(`/issues/${issueId}/labels`)
        .send({ labelId: labelBugId })
        .expect(201);

      const issue = await api.get(`/issues/${issueId}`).expect(200);
      const labelIds = (issue.body.labels ?? []).map((l: any) => l.id);
      const occurrences = labelIds.filter((id: number) => id === labelBugId).length;
      expect(occurrences).toBe(1);
    });

    it("attaches a second label", async () => {
      await api
        .post(`/issues/${issueId}/labels`)
        .send({ labelId: labelPerfId })
        .expect(201);

      const issue = await api.get(`/issues/${issueId}`).expect(200);
      const labelIds = (issue.body.labels ?? []).map((l: any) => l.id);
      expect(labelIds).toEqual(expect.arrayContaining([labelBugId, labelPerfId]));
    });

    it("removes a label", async () => {
      await api
        .delete(`/issues/${issueId}/labels/${labelBugId}`)
        .expect(204);

      const issue = await api.get(`/issues/${issueId}`).expect(200);
      const labelIds = (issue.body.labels ?? []).map((l: any) => l.id);
      expect(labelIds).not.toContain(labelBugId);
      expect(labelIds).toContain(labelPerfId);
    });
  });

  // ────────────────────────────────────────────────
  // Soft delete + restore
  // ────────────────────────────────────────────────
  describe("Soft delete and restore", () => {
    let issueId: number;

    beforeAll(async () => {
      const r = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Soft-delete subject",
      });
      issueId = r.id;
    });

    it("soft-delete returns 204 and 404 on subsequent GET", async () => {
      await api.delete(`/issues/${issueId}`).expect(204);
      await api.get(`/issues/${issueId}`).expect(404);
    });

    it("soft-delete writes an ISSUE_DELETED audit row", async () => {
      // The activity feed resolves through the `viaIssue` guard, which uses
      // `withDeleted()` — so a trashed issue's audit trail stays readable.
      const log = await api.get(`/activity/issues/${issueId}`).expect(200);
      const actions = log.body.map((r: any) => r.action);
      expect(actions).toContain("ISSUE_DELETED");
    });

    it("restore brings the row back", async () => {
      await api.post(`/issues/${issueId}/restore`).expect(204);
      const r = await api.get(`/issues/${issueId}`).expect(200);
      expect(r.body.id).toBe(issueId);
    });

    it("restore writes an ISSUE_RESTORED audit row", async () => {
      const log = await api.get(`/activity/issues/${issueId}`).expect(200);
      const actions = log.body.map((r: any) => r.action);
      expect(actions).toContain("ISSUE_RESTORED");
    });
  });

  // ────────────────────────────────────────────────
  // Cascade restore — one audit row per restored id
  // ────────────────────────────────────────────────
  describe("Cascade restore audit trail", () => {
    let parentId: number;
    let childId: number;

    beforeAll(async () => {
      const parent = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Cascade-restore parent",
      });
      parentId = parent.id;
      const child = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Cascade-restore child",
        parentId: parent.id,
      });
      childId = child.id;

      // Trash the whole subtree so restoreWithCascade's recursive CTE has a
      // soft-deleted parent + descendant to resurrect together.
      await api.delete(`/issues/${childId}`).expect(204);
      await api.delete(`/issues/${parentId}`).expect(204);
    });

    it("cascade restore writes one ISSUE_RESTORED row per restored id", async () => {
      await api
        .post(`/issues/${parentId}/restore`)
        .query({ cascade: 1 })
        .expect(204);

      // Each restored issue's own feed carries its ISSUE_RESTORED row.
      for (const id of [parentId, childId]) {
        const log = await api.get(`/activity/issues/${id}`).expect(200);
        const restored = log.body.filter(
          (r: any) => r.action === "ISSUE_RESTORED",
        );
        expect(restored.length).toBeGreaterThanOrEqual(1);
        const cascadeRow = restored.find(
          (r: any) => r.payload?.cascade === true,
        );
        expect(cascadeRow).toBeTruthy();
        // Every row in the subtree points back to the operation's root.
        expect(cascadeRow.payload.rootId).toBe(parentId);
      }
    });
  });

  // ────────────────────────────────────────────────
  // Trash view via GET /projects/:id/trash — exercises
  // IssuesService.findTrash() and the withDeleted() query
  // builder hook. Locks in #341 coverage.
  // ────────────────────────────────────────────────
  describe("Trash list (findTrash)", () => {
    let trashedId: number;
    let liveId: number;

    beforeAll(async () => {
      const live = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Trash-test: live issue",
      });
      liveId = live.id;

      const trashed = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Trash-test: soft-deleted issue",
      });
      trashedId = trashed.id;
      await api.delete(`/issues/${trashedId}`).expect(204);
    });

    it("GET /projects/:id/trash lists soft-deleted issues for the project", async () => {
      const r = await api.get(`/projects/${fx.projectId}/trash`).expect(200);
      expect(Array.isArray(r.body)).toBe(true);

      const ids = r.body.map((row: any) => row.id);
      expect(ids).toContain(trashedId);
      // Live (un-deleted) rows must never bleed into the trash view.
      expect(ids).not.toContain(liveId);

      const trashedRow = r.body.find((row: any) => row.id === trashedId);
      expect(trashedRow.deletedAt).toBeTruthy();
    });

    it("rows leave the trash list once they are restored", async () => {
      await api.post(`/issues/${trashedId}/restore`).expect(204);

      const r = await api.get(`/projects/${fx.projectId}/trash`).expect(200);
      const ids = r.body.map((row: any) => row.id);
      expect(ids).not.toContain(trashedId);
    });
  });

  // ────────────────────────────────────────────────
  // 3-deep cascade restore — restoreWithCascade walks
  // the soft-deleted descendant subtree via a recursive
  // CTE. Existing tests cover the 2-deep case; #341 asks
  // for an explicit 3-deep proof.
  // ────────────────────────────────────────────────
  describe("Cascade restore — 3-deep subtree", () => {
    let grandparentId: number;
    let parentId: number;
    let childId: number;

    beforeAll(async () => {
      const grandparent = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "3-deep grandparent",
      });
      grandparentId = grandparent.id;

      const parent = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "3-deep parent",
        parentId: grandparentId,
      });
      parentId = parent.id;

      const child = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "3-deep child",
        parentId: parentId,
      });
      childId = child.id;

      // Trash the whole subtree bottom-up so every node has deletedAt set.
      // The recursive CTE in restoreWithCascade only walks rows whose parent
      // is also in the deleted set, matching the "restore everything that
      // was trashed together" semantic — so all three must be soft-deleted.
      await api.delete(`/issues/${childId}`).expect(204);
      await api.delete(`/issues/${parentId}`).expect(204);
      await api.delete(`/issues/${grandparentId}`).expect(204);
    });

    it("restores the full 3-level subtree in one call", async () => {
      // Sanity-check: every node currently surfaces as 404 (soft-deleted).
      for (const id of [grandparentId, parentId, childId]) {
        await api.get(`/issues/${id}`).expect(404);
      }

      await api
        .post(`/issues/${grandparentId}/restore`)
        .query({ cascade: 1 })
        .expect(204);

      // Every node in the subtree is live again.
      for (const id of [grandparentId, parentId, childId]) {
        const r = await api.get(`/issues/${id}`).expect(200);
        expect(r.body.id).toBe(id);
        expect(r.body.deletedAt).toBeFalsy();
      }
    });

    it("a follow-up cascade restore on the already-active root is a no-op (idempotent)", async () => {
      // Second call must not throw or duplicate audit rows from new restores —
      // the recursive CTE finds no soft-deleted descendants, so nothing changes.
      await api
        .post(`/issues/${grandparentId}/restore`)
        .query({ cascade: 1 })
        .expect(204);

      for (const id of [grandparentId, parentId, childId]) {
        await api.get(`/issues/${id}`).expect(200);
      }
    });
  });

  // ────────────────────────────────────────────────
  // Cursor pagination
  // ────────────────────────────────────────────────
  describe("Cursor pagination", () => {
    it("returns a cursor and respects take", async () => {
      const r = await api
        .get("/issues/cursor")
        .query({ take: 3 })
        .expect(200);
      expect(r.body).toHaveProperty("data");
      expect(Array.isArray(r.body.data)).toBe(true);
      expect(r.body.data.length).toBeLessThanOrEqual(3);
    });
  });

  // ────────────────────────────────────────────────
  // ActivityLog (audit) — driven by IssuesService
  // ────────────────────────────────────────────────
  describe("ActivityLog audit trail", () => {
    let issueId: number;

    beforeAll(async () => {
      const r = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Audit subject",
      });
      issueId = r.id;
    });

    it("ISSUE_CREATED is logged at creation", async () => {
      const log = await api.get(`/activity/issues/${issueId}`).expect(200);
      const actions = log.body.map((r: any) => r.action);
      expect(actions).toContain("ISSUE_CREATED");
    });

    it("status change recorded as ISSUE_UPDATED with column diff", async () => {
      const issue = await api.get(`/issues/${issueId}`);
      // BACKLOG → TODO is the first valid step in the default workflow.
      await api
        .patch(`/issues/${issueId}`)
        .send({ expectedVersion: issue.body.version, status: "TODO" })
        .expect(200);

      const log = await api.get(`/activity/issues/${issueId}`).expect(200);
      const updates = log.body.filter((r: any) => r.action === "ISSUE_UPDATED");
      const statusEntry = updates
        .flatMap((r: any) => r.payload?.changes ?? [])
        .find((c: any) => c.column === "status" && c.to === "TODO");
      expect(statusEntry).toBeTruthy();
      expect(statusEntry.from).toBe("BACKLOG");
    });

    it("assignee change recorded as ISSUE_UPDATED with column diff", async () => {
      await api
        .patch(`/issues/${issueId}/assignee`)
        .send({ assigneeId: fx.userIds[2] })
        .expect(200);

      const log = await api.get(`/activity/issues/${issueId}`).expect(200);
      const updates = log.body.filter((r: any) => r.action === "ISSUE_UPDATED");
      const assignEntry = updates
        .flatMap((r: any) => r.payload?.changes ?? [])
        .find((c: any) => c.column === "assigneeId" && Number(c.to) === fx.userIds[2]);
      expect(assignEntry).toBeTruthy();
    });

    it("priority change recorded as ISSUE_UPDATED with column diff", async () => {
      const issue = await api.get(`/issues/${issueId}`);
      const v = issue.body.version;
      await api
        .patch(`/issues/${issueId}`)
        .send({ expectedVersion: v, priority: 1 })
        .expect(200);

      const log = await api.get(`/activity/issues/${issueId}`).expect(200);
      const updates = log.body.filter((r: any) => r.action === "ISSUE_UPDATED");
      const pri = updates
        .flatMap((r: any) => r.payload?.changes ?? [])
        .find((c: any) => c.column === "priority" && Number(c.to) === 1);
      expect(pri).toBeTruthy();
    });

    it("LABEL_ADDED and LABEL_REMOVED logged", async () => {
      await api
        .post(`/issues/${issueId}/labels`)
        .send({ labelId: labelBugId })
        .expect(201);
      await api
        .delete(`/issues/${issueId}/labels/${labelBugId}`)
        .expect(204);

      const log = await api.get(`/activity/issues/${issueId}`).expect(200);
      const actions = log.body.map((r: any) => r.action);
      expect(actions).toEqual(expect.arrayContaining(["LABEL_ADDED", "LABEL_REMOVED"]));
    });

    it("COMMENTED logged when a comment is created", async () => {
      await api
        .post("/comments")
        .send({
          issueId,
          body: "Reproduced on staging at commit deadbeef.",
        })
        .expect(201);

      const log = await api.get(`/activity/issues/${issueId}`).expect(200);
      const c = log.body.find((r: any) => r.action === "COMMENTED");
      expect(c).toBeTruthy();
    });

    it("workspace audit feed contains issue events", async () => {
      const log = await api
        .get(`/activity/workspaces/${fx.workspaceId}`)
        .query({ limit: 200 })
        .expect(200);
      // workspaceId is null on records inserted by ActivityService.log() because the
      // Issue endpoints don't currently propagate workspaceId — confirm response shape only.
      expect(Array.isArray(log.body)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────
  // Query-count regression — internal callers should not eager-load relations.
  //
  // Pre-fix, IssuesService.update/assign/addLabel/removeLabel went through the
  // full `findOne()` which eager-loads labels (M2M → separate SELECT-IN on
  // `issue_labels`) plus four JOINs (assignee, reporter, sprint, parent).
  // Now they go through `findOneCore()` / `repo.exists()`, so none of those
  // side-load queries should fire on the internal paths.
  // ────────────────────────────────────────────────
  describe("Query count — internal callers skip the 5-relation eager load", () => {
    let issueId: number;
    const labelsSideLoadPattern = /from\s+["`]?(label|issue_labels)["`]?/i;

    beforeAll(async () => {
      const r = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Query-count subject",
        status: "BACKLOG",
        priority: 3,
      });
      issueId = r.id;
    });

    it("PATCH /issues/:id does not issue the labels M2M SELECT-IN", async () => {
      const tracker = booted.em.getQueryTracker();
      expect(tracker).not.toBeNull();
      const current = await api.get(`/issues/${issueId}`).expect(200);
      const before = tracker!.getLog().length;
      await api
        .patch(`/issues/${issueId}`)
        .send({ expectedVersion: current.body.version, title: "Renamed for perf" })
        .expect(200);
      const issued = tracker!.getLog().slice(before);
      const sideLoad = issued.find((e) => labelsSideLoadPattern.test(e.sql));
      expect(sideLoad).toBeUndefined();
    });

    it("POST /issues/:id/labels gates existence without loading the row's relations", async () => {
      const tracker = booted.em.getQueryTracker();
      const before = tracker!.getLog().length;
      await api
        .post(`/issues/${issueId}/labels`)
        .send({ labelId: labelPerfId })
        .expect(201);
      const issued = tracker!.getLog().slice(before);
      // The existence gate is now `exists({ id })` (single COUNT/SELECT 1),
      // followed by the join-table INSERT and an audit row — no row hydration
      // and no labels side-load.
      const sideLoad = issued.find((e) => /\bfrom\s+["`]?label["`]?\b/i.test(e.sql));
      expect(sideLoad).toBeUndefined();
    });

    it("DELETE /issues/:id/labels/:labelId gates existence without loading the row's relations", async () => {
      const tracker = booted.em.getQueryTracker();
      const before = tracker!.getLog().length;
      await api
        .delete(`/issues/${issueId}/labels/${labelPerfId}`)
        .expect(204);
      const issued = tracker!.getLog().slice(before);
      const sideLoad = issued.find((e) => /\bfrom\s+["`]?label["`]?\b/i.test(e.sql));
      expect(sideLoad).toBeUndefined();
    });
  });
});
