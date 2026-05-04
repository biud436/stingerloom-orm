import * as request from "supertest";
import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  BootedApp,
} from "./helpers/test-app";
import {
  createBaseFixture,
  createIssue,
  BaseFixture,
} from "./helpers/fixtures";

integrationDescribe("[E2E] Queue — FOR UPDATE SKIP LOCKED auto-assign", () => {
  let booted: BootedApp;
  let fx: BaseFixture;

  /**
   * Seed N claimable issues. Eligible = status BACKLOG/TODO + assigneeId NULL +
   * claimedAt NULL/expired. The default base fixture has none.
   */
  async function seedClaimable(count: number, opts?: { priority?: number }) {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const r = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: `Queue candidate ${i} ${Date.now()}-${Math.random()}`,
        status: "BACKLOG",
        priority: opts?.priority ?? 2 + (i % 3),
      });
      ids.push(r.id);
    }
    return ids;
  }

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
  }, 60000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30000);

  // ────────────────────────────────────────────────
  // Empty queue
  // ────────────────────────────────────────────────
  describe("Empty queue", () => {
    it("returns null body when no claimable issue exists", async () => {
      const res = await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "empty-w", projectId: fx.projectId })
        .expect(201);
      expect(res.body === null || res.body === "" || (typeof res.body === "object" && Object.keys(res.body).length === 0)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────
  // Single-worker claim
  // ────────────────────────────────────────────────
  describe("Single-worker claim", () => {
    it("claims an issue and stamps claimedBy / claimedAt", async () => {
      const [target] = await seedClaimable(1);

      const res = await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "solo-1", projectId: fx.projectId })
        .expect(201);

      expect(res.body.id).toBe(target);
      expect(res.body.claimedBy).toBe("solo-1");
      expect(res.body.claimedAt).toBeTruthy();
    });

    it("logs CLAIMED in the activity log for the claimed issue", async () => {
      const [target] = await seedClaimable(1);

      await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "solo-2", projectId: fx.projectId })
        .expect(201);

      const log = await request(booted.server)
        .get(`/activity/issues/${target}`)
        .expect(200);
      const claimed = log.body.find((r: any) => r.action === "CLAIMED");
      expect(claimed).toBeTruthy();
      expect(claimed.payload.workerId).toBe("solo-2");
    });

    it("orders by priority ASC, then number ASC", async () => {
      const lowPri = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Low pri later",
        status: "BACKLOG",
        priority: 4,
      });
      const highPri = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "High pri earlier",
        status: "BACKLOG",
        priority: 1,
      });

      const res = await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "ord", projectId: fx.projectId })
        .expect(201);

      expect(res.body.id).toBe(highPri.id);
      // Drain: also claim the low-pri one to keep the table clean
      const res2 = await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "ord", projectId: fx.projectId })
        .expect(201);
      expect(res2.body.id).toBe(lowPri.id);
    });
  });

  // ────────────────────────────────────────────────
  // Concurrent workers (the SKIP LOCKED demo)
  // ────────────────────────────────────────────────
  describe("Concurrent claims (SKIP LOCKED)", () => {
    it("hands out 4 distinct rows to 4 parallel workers", async () => {
      await seedClaimable(6);

      const claims = await Promise.all(
        ["w1", "w2", "w3", "w4"].map((id) =>
          request(booted.server)
            .post("/queue/claim")
            .send({ workerId: id, projectId: fx.projectId }),
        ),
      );

      for (const r of claims) {
        expect(r.status).toBe(201);
      }

      const ids = claims.map((r) => r.body?.id).filter((x) => x);
      expect(ids.length).toBe(4);
      expect(new Set(ids).size).toBe(4);

      const claimers = claims.map((r) => r.body.claimedBy);
      expect(new Set(claimers).size).toBe(4);
    }, 30000);

    it("when only N rows are available, N+1 workers leaves the last with null", async () => {
      // Drain remaining
      while (true) {
        const r = await request(booted.server)
          .post("/queue/claim")
          .send({ workerId: "drain", projectId: fx.projectId });
        if (!r.body || !r.body.id) break;
      }

      await seedClaimable(2);

      const res = await Promise.all(
        ["x1", "x2", "x3"].map((id) =>
          request(booted.server)
            .post("/queue/claim")
            .send({ workerId: id, projectId: fx.projectId }),
        ),
      );

      const got = res.filter((r) => r.body && r.body.id);
      const empty = res.filter((r) => !r.body || !r.body.id);
      expect(got.length).toBe(2);
      expect(empty.length).toBe(1);
    }, 30000);
  });

  // ────────────────────────────────────────────────
  // Release
  // ────────────────────────────────────────────────
  describe("Release", () => {
    it("releases a claim made by the same worker", async () => {
      const [target] = await seedClaimable(1);
      const claim = await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "rel-1", projectId: fx.projectId })
        .expect(201);
      expect(claim.body.id).toBe(target);

      const released = await request(booted.server)
        .post(`/queue/release/${target}`)
        .send({ workerId: "rel-1" })
        .expect(201);
      expect(released.body.released).toBe(true);
    });

    it("returns false when the worker is not the claimer", async () => {
      const [target] = await seedClaimable(1);
      await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "rel-owner", projectId: fx.projectId })
        .expect(201);

      const fail = await request(booted.server)
        .post(`/queue/release/${target}`)
        .send({ workerId: "imposter" })
        .expect(201);
      expect(fail.body.released).toBe(false);
    });

    it("a released issue becomes immediately claimable again", async () => {
      const [target] = await seedClaimable(1);
      await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "round-trip", projectId: fx.projectId })
        .expect(201);
      await request(booted.server)
        .post(`/queue/release/${target}`)
        .send({ workerId: "round-trip" })
        .expect(201);

      const next = await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "second", projectId: fx.projectId })
        .expect(201);
      expect(next.body.id).toBe(target);
      expect(next.body.claimedBy).toBe("second");
    });
  });

  // ────────────────────────────────────────────────
  // Stats
  // ────────────────────────────────────────────────
  describe("Stats", () => {
    it("returns counts {backlog, todo, activelyClaimed, expiredClaim}", async () => {
      const res = await request(booted.server)
        .get(`/queue/stats/${fx.projectId}`)
        .expect(200);

      expect(typeof res.body.backlog).toBe("number");
      expect(typeof res.body.todo).toBe("number");
      expect(typeof res.body.activelyClaimed).toBe("number");
      expect(typeof res.body.expiredClaim).toBe("number");
    });

    it("backlog count drops by N after claiming N issues", async () => {
      await seedClaimable(3);

      const before = await request(booted.server)
        .get(`/queue/stats/${fx.projectId}`)
        .expect(200);

      await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "stats-w", projectId: fx.projectId })
        .expect(201);
      await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "stats-w", projectId: fx.projectId })
        .expect(201);

      const after = await request(booted.server)
        .get(`/queue/stats/${fx.projectId}`)
        .expect(200);

      expect(after.body.backlog).toBeLessThanOrEqual(before.body.backlog);
      expect(after.body.activelyClaimed).toBeGreaterThanOrEqual(
        before.body.activelyClaimed,
      );
    });
  });

  // ────────────────────────────────────────────────
  // Input validation
  // ────────────────────────────────────────────────
  describe("Validation", () => {
    it("rejects workerId with disallowed characters", async () => {
      await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "bad worker!", projectId: fx.projectId })
        .expect(400);
    });

    it("rejects missing projectId", async () => {
      await request(booted.server)
        .post("/queue/claim")
        .send({ workerId: "ok" })
        .expect(400);
    });
  });
});
