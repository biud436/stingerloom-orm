import * as request from "supertest";
import { uniqueSuffix, projectKey, mintToken } from "./test-app";

export interface BaseFixture {
  workspaceId: number;
  workspaceSlug: string;
  /** Creator (OWNER). Their token is on `ownerToken`. */
  ownerId: number;
  ownerToken: string;
  /** All users in the fixture, including the owner at index 0. */
  userIds: number[];
  userTokens: string[];
  projectId: number;
  projectKey: string;
}

/**
 * Module-level default token used by fixture helpers when the caller did not
 * pass one. Set by `createBaseFixture` so older `createIssue(server, body)`
 * call sites keep working without leaking auth concerns into every assertion.
 */
let defaultToken: string | null = null;

export function setDefaultAuthToken(token: string | null): void {
  defaultToken = token;
}

export function getDefaultAuthToken(): string | null {
  return defaultToken;
}

function authHeader(explicit?: string): string {
  const token = explicit ?? defaultToken;
  if (!token) {
    throw new Error(
      "No JWT available — call createBaseFixture first or pass a token explicitly",
    );
  }
  return `Bearer ${token}`;
}

/**
 * Creates an isolated workspace + 4 users (all members) + 1 project + JWTs
 * for each user. Used by every spec file as the starting state — every
 * key/slug/email is salted so parallel-run files do not collide.
 *
 * The first user creates the workspace and is auto-enrolled as OWNER. The
 * other three are invited as MEMBER via `/memberships`. The owner's token
 * is also installed as the module default so legacy fixture calls
 * (`createIssue(server, body)`) keep working.
 */
export async function createBaseFixture(server: any): Promise<BaseFixture> {
  const suffix = uniqueSuffix("t");
  const slug = `acme-${suffix}`.slice(0, 39);

  const handles = ["alice", "bob", "chris", "dana"];
  const userIds: number[] = [];
  const userTokens: string[] = [];

  for (const handle of handles) {
    const r = await request(server)
      .post("/auth/register")
      .send({
        email: `${handle}-${suffix}@acme.test`,
        name: handle,
        password: "fixture-password-123",
      })
      .expect(201);
    userIds.push(r.body.user.id);
    userTokens.push(r.body.accessToken);
  }

  const ownerToken = userTokens[0];
  setDefaultAuthToken(ownerToken);

  const ws = await request(server)
    .post("/workspaces")
    .set("Authorization", authHeader())
    .send({ name: `Acme ${suffix}`, slug })
    .expect(201);

  for (let i = 1; i < userIds.length; i++) {
    await request(server)
      .post("/memberships")
      .set("Authorization", authHeader())
      .send({ workspaceId: ws.body.id, userId: userIds[i], role: "MEMBER" })
      .expect(201);
  }

  const key = projectKey(suffix);
  const proj = await request(server)
    .post("/projects")
    .set("Authorization", authHeader())
    .send({
      workspaceId: ws.body.id,
      name: `Platform ${suffix}`,
      key,
      customFieldSchema: {
        fields: [
          { key: "severity", type: "enum", options: ["S0", "S1", "S2", "S3"] },
        ],
      },
    })
    .expect(201);

  return {
    workspaceId: ws.body.id,
    workspaceSlug: slug,
    ownerId: userIds[0],
    ownerToken,
    userIds,
    userTokens,
    projectId: proj.body.id,
    projectKey: key,
  };
}

export async function createSprint(
  server: any,
  projectId: number,
  daysAround = 7,
  token?: string,
): Promise<number> {
  const today = new Date();
  const start = new Date(today.getTime() - daysAround * 86400000);
  const end = new Date(today.getTime() + daysAround * 86400000);
  const r = await request(server)
    .post("/sprints")
    .set("Authorization", authHeader(token))
    .send({
      projectId,
      name: `Sprint ${start.toISOString().slice(0, 10)}`,
      status: "ACTIVE",
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    })
    .expect(201);
  return r.body.id;
}

export async function createLabel(
  server: any,
  projectId: number,
  name: string,
  token?: string,
): Promise<number> {
  const r = await request(server)
    .post("/labels")
    .set("Authorization", authHeader(token))
    .send({ projectId, name })
    .expect(201);
  return r.body.id;
}

export async function createIssue(
  server: any,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ id: number; number: number; version: number; status: string }> {
  const r = await request(server)
    .post("/issues")
    .set("Authorization", authHeader(token))
    .send(body)
    .expect(201);
  return r.body;
}

export { mintToken };
