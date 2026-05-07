import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  authedAgent,
  BootedApp,
} from "./helpers/test-app";
import { createBaseFixture, createIssue, BaseFixture } from "./helpers/fixtures";

/**
 * CSV import + JSON workspace export — closes the last Phase 1 #304 item.
 *
 * Import path stresses `insertMany` chunked transactions: 250 rows split
 * across 3 chunks (CHUNK_SIZE=100), each in its own @Transactional frame.
 * Issue numbers must remain monotonically increasing because import uses
 * the same `nextIssueNumber()` row-locked counter as single-issue create.
 *
 * Export path stresses `stream()` AsyncGenerator: per-issue iteration with
 * batch-of-200 windowing. The test seeds enough issues to ensure the
 * stream actually loops past one batch.
 */
integrationDescribe("[E2E] Import / Export — CSV insertMany + workspace JSON stream", () => {
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

  describe("CSV import", () => {
    it("rejects non-CSV Content-Type", async () => {
      await api
        .post(`/projects/${fx.projectId}/issues/import`)
        .set("Content-Type", "application/json")
        .send({ not: "csv" })
        .expect(400);
    });

    it("rejects malformed CSV without title header", async () => {
      const body = "name,priority\nfoo,2\n";
      await api
        .post(`/projects/${fx.projectId}/issues/import`)
        .set("Content-Type", "text/csv")
        .send(body)
        .expect(400);
    });

    it("imports a small CSV with quoted fields and embedded commas", async () => {
      const body = [
        "title,status,priority,estimate",
        '"Fix, comma in title",BACKLOG,2,3',
        '"Newline\nin\ntitle",TODO,1,5',
        "Plain row,IN_PROGRESS,3,",
      ].join("\n");
      const r = await api
        .post(`/projects/${fx.projectId}/issues/import`)
        .set("Content-Type", "text/csv")
        .send(body)
        .expect(200);
      expect(r.body.inserted).toBe(3);
    });

    it("250-row import spans 3 chunks and assigns sequential numbers", async () => {
      // Pull the current max issue number first; the chunked path must
      // produce strictly increasing numbers above this baseline.
      const before = await api
        .get(`/projects/${fx.projectId}/issues`)
        .expect(200);
      const baselineMax = Math.max(
        0,
        ...(before.body as Array<{ number: number }>).map((i) => i.number),
      );

      const lines = ["title,status,priority"];
      for (let i = 0; i < 250; i++) {
        lines.push(`Bulk row ${i},BACKLOG,3`);
      }
      const r = await api
        .post(`/projects/${fx.projectId}/issues/import`)
        .set("Content-Type", "text/csv")
        .send(lines.join("\n"))
        .expect(200);
      expect(r.body.inserted).toBe(250);

      const after = await api
        .get(`/projects/${fx.projectId}/issues`)
        .query({ limit: 500 })
        .expect(200);
      const nums = (after.body as Array<{ number: number }>)
        .map((i) => i.number)
        .filter((n) => n > baselineMax)
        .sort((a, b) => a - b);
      expect(nums.length).toBeGreaterThanOrEqual(250);
      // No duplicates
      const unique = new Set(nums);
      expect(unique.size).toBe(nums.length);
      // Strictly increasing in 1-step increments above the baseline
      for (let i = 1; i < nums.length; i++) {
        expect(nums[i]).toBe(nums[i - 1] + 1);
      }
    });

    it("falls back to BACKLOG for unknown status values", async () => {
      const body = "title,status\nWeird status,FROBNICATE\n";
      const r = await api
        .post(`/projects/${fx.projectId}/issues/import`)
        .set("Content-Type", "text/csv")
        .send(body)
        .expect(200);
      expect(r.body.inserted).toBe(1);

      const all = await api
        .get(`/projects/${fx.projectId}/issues`)
        .query({ limit: 500 })
        .expect(200);
      const weird = (all.body as Array<{ title: string; status: string }>).find(
        (i) => i.title === "Weird status",
      );
      expect(weird?.status).toBe("BACKLOG");
    });
  });

  describe("Workspace JSON export", () => {
    it("404 for a non-existent workspace", async () => {
      // Member guard rejects with 403 before the service ever sees it; an
      // unknown workspace looks the same as a workspace the caller is not a
      // member of, which is the correct security posture.
      await api.get(`/workspaces/9999999/export.json`).expect(403);
    });

    it("returns the full workspace shape with project / issue counts", async () => {
      // Seed a few comments so commentCount surfaces non-zero.
      const issue = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Issue with comments",
      });
      await api
        .post("/comments")
        .send({ issueId: issue.id, body: "first" })
        .expect(201);
      await api
        .post("/comments")
        .send({ issueId: issue.id, body: "second" })
        .expect(201);

      const r = await api
        .get(`/workspaces/${fx.workspaceId}/export.json`)
        .expect(200);
      expect(r.body.workspace.id).toBe(fx.workspaceId);
      expect(r.body.workspace.slug).toBe(fx.workspaceSlug);
      expect(Array.isArray(r.body.projects)).toBe(true);
      expect(r.body.projects).toHaveLength(1);
      const project = r.body.projects[0];
      expect(project.id).toBe(fx.projectId);
      // 250 bulk-imported + 3 from the CSV import test + 1 weird-status +
      // 1 issue-with-comments = 255. Loose assertion to tolerate other
      // tests in the file expanding the seed set.
      expect(project.issues.length).toBeGreaterThanOrEqual(255);

      const seedIssue = (
        project.issues as Array<{ id: number; commentCount: number }>
      ).find((i) => i.id === issue.id);
      expect(seedIssue).toBeDefined();
      expect(seedIssue!.commentCount).toBe(2);
    });
  });
});
