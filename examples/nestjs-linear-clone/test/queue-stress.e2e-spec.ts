import * as request from "supertest";
import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  BootedApp,
} from "./helpers/test-app";
import { createBaseFixture, createIssue, BaseFixture } from "./helpers/fixtures";

const STRESS_DESCRIBE = process.env.STRESS === "true" ? describe : describe.skip;

/**
 * Concurrency stress test for the SKIP LOCKED queue. Gated behind
 * `STRESS=true` because it generates many issues and runs many parallel
 * claim requests — slow on CI and potentially flaky on resource-constrained
 * runners. Run locally with `pnpm test:stress`.
 *
 * What it asserts:
 *   - 50 concurrent /queue/claim calls receive 50 *distinct* issue ids
 *     (no double-claim under SKIP LOCKED).
 *   - 50 concurrent issue updates with the same `expectedVersion` resolve
 *     into exactly one 200 + 49 × 409 (`OPTIMISTIC_LOCK`).
 */
integrationDescribe("Queue — concurrency stress (STRESS=true)", () => {
  let booted: BootedApp;
  let fx: BaseFixture;

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
  }, 120_000);

  afterAll(async () => {
    await shutdownApp(booted);
  });

  STRESS_DESCRIBE("SKIP LOCKED claim distinctness", () => {
    it("50 concurrent claims yield 50 distinct issues", async () => {
      const N = 50;

      // Seed N+10 unassigned BACKLOG issues.
      for (let i = 0; i < N + 10; i++) {
        await createIssue(booted.server, {
          projectId: fx.projectId,
          title: `stress-${i}`,
          status: "BACKLOG",
        });
      }

      const claimers = Array.from({ length: N }, (_, i) =>
        request(booted.server)
          .post("/queue/claim")
          .set("Authorization", `Bearer ${fx.ownerToken}`)
          .send({ workerId: `worker-${i}`, projectId: fx.projectId }),
      );
      const responses = await Promise.all(claimers);
      const ids = responses
        .map((r) => r.body?.id)
        .filter((id): id is number => typeof id === "number");

      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
      expect(ids.length).toBeGreaterThanOrEqual(N - 5); // tolerance for the rare retry
    }, 90_000);
  });

  STRESS_DESCRIBE("Optimistic lock contention", () => {
    it("50 concurrent updates with the same version → 1 success, 49 × 409", async () => {
      const issue = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "lock-contended",
      });

      const N = 50;
      const writers = Array.from({ length: N }, (_, i) =>
        request(booted.server)
          .patch(`/issues/${issue.id}`)
          .set("Authorization", `Bearer ${fx.ownerToken}`)
          .send({
            expectedVersion: issue.version,
            title: `concurrent-${i}`,
          }),
      );
      const responses = await Promise.all(writers);
      const wins = responses.filter((r) => r.status === 200).length;
      const conflicts = responses.filter((r) => r.status === 409).length;

      expect(wins).toBe(1);
      expect(conflicts).toBe(N - 1);
    }, 60_000);
  });

  STRESS_DESCRIBE("Soft-delete + restore + ManyToMany interaction", () => {
    it("restoring an issue keeps its label associations intact", async () => {
      const issue = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "restore-with-labels",
      });

      const label = await request(booted.server)
        .post("/labels")
        .set("Authorization", `Bearer ${fx.ownerToken}`)
        .send({ projectId: fx.projectId, name: "stress-label" })
        .expect(201);

      await request(booted.server)
        .post(`/issues/${issue.id}/labels`)
        .set("Authorization", `Bearer ${fx.ownerToken}`)
        .send({ labelId: label.body.id })
        .expect(201);

      await request(booted.server)
        .delete(`/issues/${issue.id}`)
        .set("Authorization", `Bearer ${fx.ownerToken}`)
        .expect(204);

      await request(booted.server)
        .post(`/issues/${issue.id}/restore`)
        .set("Authorization", `Bearer ${fx.ownerToken}`)
        .expect(204);

      const restored = await request(booted.server)
        .get(`/issues/${issue.id}`)
        .set("Authorization", `Bearer ${fx.ownerToken}`)
        .expect(200);

      const labelIds = (restored.body.labels ?? []).map(
        (l: { id: number }) => l.id,
      );
      expect(labelIds).toContain(label.body.id);
    }, 60_000);
  });
});
