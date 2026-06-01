import { sql } from "@stingerloom/orm";
import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  authedAgent,
  BootedApp,
} from "./helpers/test-app";
import { createBaseFixture, BaseFixture } from "./helpers/fixtures";
import { IdempotencyKey } from "../src/common/idempotency/idempotency-key.entity";

integrationDescribe("[E2E] Idempotency-Key header", () => {
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

  it("first POST with Idempotency-Key creates the resource", async () => {
    const key = `idem-first-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = {
      projectId: fx.projectId,
      title: `Idempotent issue ${key}`,
      status: "BACKLOG",
      priority: 3,
    };
    const r = await api
      .post("/issues")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(201);
    expect(r.body.id).toBeDefined();
    expect(r.body.title).toBe(body.title);
  });

  it("replay of the same key + body returns the same resource", async () => {
    const key = `idem-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = {
      projectId: fx.projectId,
      title: `Replay subject ${key}`,
      status: "BACKLOG",
      priority: 3,
    };
    const first = await api
      .post("/issues")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(201);
    const replay = await api
      .post("/issues")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);
  });

  it("same key with a different body returns 422 IDEMPOTENCY_KEY_COLLISION", async () => {
    const key = `idem-collide-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await api
      .post("/issues")
      .set("Idempotency-Key", key)
      .send({
        projectId: fx.projectId,
        title: `Collision A ${key}`,
        status: "BACKLOG",
        priority: 3,
      })
      .expect(201);

    const collision = await api
      .post("/issues")
      .set("Idempotency-Key", key)
      .send({
        projectId: fx.projectId,
        title: `Collision B ${key}`,
        status: "BACKLOG",
        priority: 3,
      })
      .expect(422);
    expect(collision.body.code).toBe("IDEMPOTENCY_KEY_COLLISION");
  });

  it("POST without Idempotency-Key uses the normal path (no replay)", async () => {
    const t1 = `Normal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const r1 = await api
      .post("/issues")
      .send({
        projectId: fx.projectId,
        title: t1,
        status: "BACKLOG",
        priority: 3,
      })
      .expect(201);
    const r2 = await api
      .post("/issues")
      .send({
        projectId: fx.projectId,
        title: t1,
        status: "BACKLOG",
        priority: 3,
      })
      .expect(201);
    expect(r1.body.id).not.toBe(r2.body.id);
  });

  it("malformed Idempotency-Key (too long / bad chars) returns 400", async () => {
    const tooLong = "x".repeat(200);
    await api
      .post("/issues")
      .set("Idempotency-Key", tooLong)
      .send({
        projectId: fx.projectId,
        title: "Bad key",
        status: "BACKLOG",
        priority: 3,
      })
      .expect(400);
  });

  // ── Issue #362: persisted status must be the route's DECLARED status,
  // not the stale `res.statusCode` (200) read before Nest applies @HttpCode.

  it("#362 a 201 POST route replays with 201, not 200", async () => {
    const key = `idem-201-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = {
      projectId: fx.projectId,
      title: `Status 201 ${key}`,
      status: "BACKLOG",
      priority: 3,
    };
    // First call: Nest applies the POST default 201.
    await api
      .post("/issues")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(201);
    // Replay short-circuits Nest — it must re-emit the SAME 201, not 200.
    await api
      .post("/issues")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(201);
  });

  it("#362 a @HttpCode(204) DELETE route returns 204 on first call AND on replay", async () => {
    // Need a concrete issue to delete.
    const created = await api
      .post("/issues")
      .send({
        projectId: fx.projectId,
        title: `To delete ${Date.now()}`,
        status: "BACKLOG",
        priority: 3,
      })
      .expect(201);
    const issueId = created.body.id as number;

    const key = `idem-204-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // First DELETE: route declares @HttpCode(204).
    await api
      .delete(`/issues/${issueId}`)
      .set("Idempotency-Key", key)
      .expect(204);
    // Replay: must re-emit 204 from the stored row, NOT fall back to 200.
    await api
      .delete(`/issues/${issueId}`)
      .set("Idempotency-Key", key)
      .expect(204);
  });

  // ── Issue #361: a STALE in_flight claim (writer crashed before persisting
  // the result) must be re-claimable instead of 409-ing until the 24h TTL.

  it("#361 a fresh in_flight row still returns 409 IDEMPOTENCY_IN_FLIGHT", async () => {
    const key = `idem-fresh-inflight-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = {
      projectId: fx.projectId,
      title: `Fresh in-flight ${key}`,
      status: "BACKLOG",
      priority: 3,
    };
    await seedInFlight(key, body, /* ageMs */ 0);

    const r = await api
      .post("/issues")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(409);
    expect(r.body.code).toBe("IDEMPOTENCY_IN_FLIGHT");
  });

  it("#361 a STALE in_flight row is re-claimed and the handler re-runs (no permanent 409)", async () => {
    const key = `idem-stale-inflight-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = {
      projectId: fx.projectId,
      title: `Stale in-flight ${key}`,
      status: "BACKLOG",
      priority: 3,
    };
    // Simulate a crash: an in_flight row whose lease expired ~10 minutes ago
    // (well past the 2-minute default lease window).
    await seedInFlight(key, body, /* ageMs */ 10 * 60 * 1000);

    // The retry must NOT 409 — it re-leases the stale row and re-runs.
    const r = await api
      .post("/issues")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(201);
    expect(r.body.id).toBeDefined();
    expect(r.body.title).toBe(body.title);

    // And once completed, a further replay returns the cached resource.
    const replay = await api
      .post("/issues")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(r.body.id);
  });

  /**
   * Insert an `in_flight` idempotency-key row directly, with a request hash
   * that matches what the interceptor computes for `POST /issues` + `body`, and
   * a `createdAt` aged by `ageMs` to simulate a stale (crashed) claim.
   *
   * The request hash is `sha256("POST\n<url>\n<stableStringify(body)>")[:64]`.
   */
  async function seedInFlight(
    key: string,
    body: Record<string, unknown>,
    ageMs: number,
  ): Promise<void> {
    const { createHash } = await import("node:crypto");
    const requestHash = createHash("sha256")
      .update(`POST\n/issues\n${stableStringify(body)}`)
      .digest("hex")
      .slice(0, 64);

    const now = Date.now();
    const fmt = (ms: number) =>
      new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const createdSql = fmt(now - ageMs);
    const expiresSql = fmt(now + 24 * 3600 * 1000);

    const I = booted.em.ref(IdempotencyKey);
    const isMysql = booted.em.getDriver().isMySqlFamily();
    const insertSql = isMysql
      ? sql`INSERT INTO ${I} (${I.key}, ${I.userId}, ${I.requestHash}, ${I.status}, ${I.expiresAt}, ${I.createdAt}) VALUES (${key}, ${null}, ${requestHash}, ${"in_flight"}, ${expiresSql}, ${createdSql})`
      : sql`INSERT INTO ${I} (${I.key}, ${I.userId}, ${I.requestHash}, ${I.status}, ${I.expiresAt}, ${I.createdAt}) VALUES (${key}, ${null}, ${requestHash}, ${"in_flight"}, ${expiresSql}::timestamp, ${createdSql}::timestamp)`;
    await booted.em.query(insertSql);
  }
});

/**
 * Mirror of the interceptor's `stableStringify` so the seeded `requestHash`
 * matches the value the interceptor computes for the same body. Kept local so
 * the test does not depend on the interceptor exporting an internal helper.
 */
function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          stableStringify((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
