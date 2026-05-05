import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  authedAgent,
  BootedApp,
} from "./helpers/test-app";
import { createBaseFixture, BaseFixture } from "./helpers/fixtures";

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
});
