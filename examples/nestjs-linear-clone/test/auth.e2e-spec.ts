import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  authedAgent,
  uniqueSuffix,
} from "./helpers/test-app";
import * as request from "supertest";

/**
 * Auth roundtrip: register → password login.
 *
 * Regression for the `passwordHash` exclusion direction. The column is
 * `@Exclude({ toPlainOnly: true })` so it is hidden in serialized responses but
 * still LOADED from the DB — a plain `@Exclude()` strips it on load (the ORM
 * deserializes via plainToClass), which made `AuthService.login`'s
 * `bcrypt.compare(password, user.passwordHash)` always see `undefined` and
 * every password login 401.
 */
integrationDescribe("[E2E] Auth — register + password login", () => {
  let booted: Awaited<ReturnType<typeof bootApp>>;

  beforeAll(async () => {
    booted = await bootApp();
  }, 60000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30000);

  it("registers, then logs in with the correct password (200 + token)", async () => {
    const suffix = uniqueSuffix("auth");
    const email = `${suffix}@acme.test`;
    const password = "correct-horse-battery-staple";

    const reg = await request(booted.server)
      .post("/auth/register")
      .send({ email, name: "auth user", password })
      .expect(201);
    expect(reg.body.accessToken).toBeTruthy();
    expect(reg.body.user.id).toBeGreaterThan(0);
    // The register response is hand-built but must never expose the hash.
    expect(reg.body.user.passwordHash).toBeUndefined();

    const login = await request(booted.server)
      .post("/auth/login")
      .send({ email, password })
      .expect(200);
    expect(login.body.accessToken).toBeTruthy();
  });

  it("rejects a wrong password with 401", async () => {
    const suffix = uniqueSuffix("auth");
    const email = `${suffix}@acme.test`;
    await request(booted.server)
      .post("/auth/register")
      .send({ email, name: "auth user", password: "the-right-password-1" })
      .expect(201);

    await request(booted.server)
      .post("/auth/login")
      .send({ email, password: "the-wrong-password-2" })
      .expect(401);
  });

  it("never serializes passwordHash on user reads", async () => {
    const suffix = uniqueSuffix("auth");
    const email = `${suffix}@acme.test`;
    const reg = await request(booted.server)
      .post("/auth/register")
      .send({ email, name: "auth user", password: "the-right-password-1" })
      .expect(201);
    const token = reg.body.accessToken as string;
    const userId = reg.body.user.id as number;

    const api = authedAgent(booted.server, token);
    const got = await api.get(`/users/${userId}`).expect(200);
    expect(got.body.id).toBe(userId);
    expect(got.body.passwordHash).toBeUndefined();
  });
});
