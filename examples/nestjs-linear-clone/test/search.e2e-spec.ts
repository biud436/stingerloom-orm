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

integrationDescribe("[E2E] Search — full-text + JSON custom field", () => {
  let booted: BootedApp;
  let fx: BaseFixture;
  let api: ReturnType<typeof authedAgent>;

  // Issue ids by topic
  let connectionPoolId: number;
  let oauthCallbackId: number;
  let s0SeverityId: number;
  let s2SeverityId: number;

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
    api = authedAgent(booted.server, fx.ownerToken);

    const seed = [
      {
        title: "Connection pool starvation under traffic spike",
        description:
          "Database connection pool drains during deployment, requests time out.",
        custom: { severity: "S0", customer: "BigCorp" },
      },
      {
        title: "OAuth callback drops state parameter on retry",
        description:
          "Browser back button replays callback URL but state is regenerated.",
        custom: { severity: "S2", customer: "AcmeRetail" },
      },
      {
        title: "Pagination cursor decoding edge case",
        description: "Cursor strings with trailing equals signs are rejected.",
        custom: { severity: "S2", customer: "BigCorp" },
      },
      {
        title: "Token refresh race condition",
        description: "Two parallel refresh calls clobber each other.",
        custom: { severity: "S1", customer: "BigCorp" },
      },
    ];

    const ids: number[] = [];
    for (const s of seed) {
      const r = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: s.title,
        description: s.description,
        customFields: s.custom,
      });
      ids.push(r.id);
    }
    [connectionPoolId, oauthCallbackId, s2SeverityId] = ids;
    s0SeverityId = connectionPoolId; // first issue carries severity=S0

    // Add a comment so the FTS UNION ALL also has comment hits
    await api
      .post("/comments")
      .send({
        issueId: oauthCallbackId,
        body: "Reproduced during deployment with intermittent connection failures.",
      })
      .expect(201);

    // Wait briefly so MySQL FULLTEXT and PostgreSQL GIN indexes settle
    await new Promise((r) => setTimeout(r, 1500));
  }, 90000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30000);

  // ────────────────────────────────────────────────
  // Full-text search
  // ────────────────────────────────────────────────
  describe("Full-text search", () => {
    it("rejects too-short query strings", async () => {
      await api
        .get("/search/issues")
        .query({ q: "a" })
        .expect(400);
    });

    it("rejects missing q", async () => {
      await api.get("/search/issues").expect(400);
    });

    it("finds issues by title keyword", async () => {
      const res = await api
        .get("/search/issues")
        .query({ q: "connection", projectId: fx.projectId, limit: 50 })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const ids = res.body.map((r: any) => r.id);
      expect(ids).toContain(connectionPoolId);
    });

    it("returns rank as a number on each hit", async () => {
      const res = await api
        .get("/search/issues")
        .query({ q: "connection", projectId: fx.projectId, limit: 50 })
        .expect(200);

      for (const row of res.body) {
        expect(typeof row.rank).toBe("number");
        expect(row.rank).toBeGreaterThanOrEqual(0);
        expect(["issue", "comment"]).toContain(row.source);
      }
    });

    it("rank ordering is non-increasing", async () => {
      const res = await api
        .get("/search/issues")
        .query({ q: "connection", projectId: fx.projectId, limit: 50 })
        .expect(200);

      for (let i = 1; i < res.body.length; i++) {
        expect(res.body[i].rank).toBeLessThanOrEqual(res.body[i - 1].rank);
      }
    });

    it("includes comment-source hits via UNION ALL", async () => {
      const res = await api
        .get("/search/issues")
        .query({ q: "deployment", projectId: fx.projectId, limit: 50 })
        .expect(200);

      const sources = res.body.map((r: any) => r.source);
      expect(sources).toContain("comment");
    });

    it("respects projectId filter", async () => {
      // Create a second project + issue with the same keyword
      const projB = await api
        .post("/projects")
        .send({
          workspaceId: fx.workspaceId,
          name: "Other",
          key: fx.projectKey.replace(/.$/, "Z"),
        })
        .expect(201);

      const ext = await createIssue(booted.server, {
        projectId: projB.body.id,
        title: "External connection pool issue",
      });

      await new Promise((r) => setTimeout(r, 1000));

      const inA = await api
        .get("/search/issues")
        .query({ q: "connection", projectId: fx.projectId, limit: 50 })
        .expect(200);

      const idsInA = inA.body.map((r: any) => r.id);
      expect(idsInA).not.toContain(ext.id);
    });

    it("applies limit cap", async () => {
      const res = await api
        .get("/search/issues")
        .query({ q: "connection", projectId: fx.projectId, limit: 1 })
        .expect(200);

      expect(res.body.length).toBeLessThanOrEqual(1);
    });
  });

  // ────────────────────────────────────────────────
  // JSON custom field
  // ────────────────────────────────────────────────
  describe("JSON custom field filter", () => {
    it("returns issues with the matching severity value", async () => {
      const res = await api
        .get("/search/by-custom-field")
        .query({ projectId: fx.projectId, key: "severity", value: "S0" })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      const ids = res.body.map((r: any) => r.id);
      expect(ids).toContain(s0SeverityId);
      for (const r of res.body) {
        expect(r.customFieldValue).toBe("S0");
      }
    });

    it("returns multiple matches when many issues share the value", async () => {
      const res = await api
        .get("/search/by-custom-field")
        .query({ projectId: fx.projectId, key: "severity", value: "S2" })
        .expect(200);

      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it("returns empty array on a value with no matches", async () => {
      const res = await api
        .get("/search/by-custom-field")
        .query({ projectId: fx.projectId, key: "severity", value: "DOES-NOT-EXIST" })
        .expect(200);

      expect(res.body).toEqual([]);
    });

    it("rejects keys with non-identifier characters (defends JSON path injection)", async () => {
      const tries = [
        "bad-key",
        "with space",
        `'OR 1=1`,
        `severity'.x`,
        `'; DROP TABLE issue; --`,
      ];
      for (const key of tries) {
        await api
          .get("/search/by-custom-field")
          .query({ projectId: fx.projectId, key, value: "S0" })
          .expect(400);
      }
    });

    it("requires all of projectId/key/value", async () => {
      await api
        .get("/search/by-custom-field")
        .query({ projectId: fx.projectId, key: "severity" })
        .expect(400);
      await api
        .get("/search/by-custom-field")
        .query({ projectId: fx.projectId, value: "S0" })
        .expect(400);
    });
  });
});
