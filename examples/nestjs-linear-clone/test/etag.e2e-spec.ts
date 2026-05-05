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

integrationDescribe("[E2E] ETag / If-Match concurrency", () => {
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

  it("GET /issues/:id sets ETag = W/\"<version>\"", async () => {
    const issue = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "ETag echo",
      status: "BACKLOG",
      priority: 3,
    });

    const res = await api.get(`/issues/${issue.id}`).expect(200);
    expect(res.headers.etag).toBe(`W/"${res.body.version}"`);
  });

  it("GET with matching If-None-Match returns 304 Not Modified", async () => {
    const issue = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "304 me",
      status: "BACKLOG",
      priority: 3,
    });

    const first = await api.get(`/issues/${issue.id}`).expect(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeDefined();

    const cached = await api
      .get(`/issues/${issue.id}`)
      .set("If-None-Match", etag)
      .expect(304);
    expect(cached.body).toEqual({});
  });

  it("PATCH with matching If-Match succeeds and bumps the ETag", async () => {
    const issue = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "If-Match success path",
      status: "BACKLOG",
      priority: 3,
    });
    const v0 = issue.version;

    const updated = await api
      .patch(`/issues/${issue.id}`)
      .set("If-Match", `W/"${v0}"`)
      .send({ title: "If-Match success path (renamed)" })
      .expect(200);
    expect(updated.body.title).toBe("If-Match success path (renamed)");
    expect(updated.body.version).toBe(v0 + 1);
    expect(updated.headers.etag).toBe(`W/"${v0 + 1}"`);
  });

  it("PATCH with stale If-Match returns 412 Precondition Failed", async () => {
    const issue = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "412 path",
      status: "BACKLOG",
      priority: 3,
    });
    const v0 = issue.version;

    // Bump the row out from under the stale anchor
    await api
      .patch(`/issues/${issue.id}`)
      .set("If-Match", `W/"${v0}"`)
      .send({ priority: 2 })
      .expect(200);

    const stale = await api
      .patch(`/issues/${issue.id}`)
      .set("If-Match", `W/"${v0}"`)
      .send({ priority: 1 })
      .expect(412);
    expect(stale.body.code).toBe("PRECONDITION_FAILED");
    expect(stale.body.currentVersion).toBe(v0 + 1);
  });

  it("PATCH without If-Match falls back to body.expectedVersion", async () => {
    const issue = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "body path",
      status: "BACKLOG",
      priority: 3,
    });
    const updated = await api
      .patch(`/issues/${issue.id}`)
      .send({ expectedVersion: issue.version, title: "body path renamed" })
      .expect(200);
    expect(updated.body.title).toBe("body path renamed");
  });

  it("PATCH without If-Match and without expectedVersion returns 400", async () => {
    const issue = await createIssue(booted.server, {
      projectId: fx.projectId,
      title: "400 path",
      status: "BACKLOG",
      priority: 3,
    });
    await api
      .patch(`/issues/${issue.id}`)
      .send({ title: "no anchor" })
      .expect(400);
  });
});
