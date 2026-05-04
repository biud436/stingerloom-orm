import * as request from "supertest";
import { uniqueSuffix, projectKey } from "./test-app";

export interface BaseFixture {
  workspaceId: number;
  workspaceSlug: string;
  userIds: number[];
  projectId: number;
  projectKey: string;
}

/**
 * Creates an isolated workspace + 4 users (all members) + 1 project.
 * Used by every spec file as the starting state — every key/slug/email
 * is salted so parallel-run files do not collide.
 */
export async function createBaseFixture(server: any): Promise<BaseFixture> {
  const suffix = uniqueSuffix("t");
  const slug = `acme-${suffix}`.slice(0, 39);

  const ws = await request(server)
    .post("/workspaces")
    .send({ name: `Acme ${suffix}`, slug })
    .expect(201);

  const userIds: number[] = [];
  for (const handle of ["alice", "bob", "chris", "dana"]) {
    const r = await request(server)
      .post("/users")
      .send({ email: `${handle}-${suffix}@acme.test`, name: handle })
      .expect(201);
    userIds.push(r.body.id);
  }

  for (const userId of userIds) {
    await request(server)
      .post("/memberships")
      .send({ workspaceId: ws.body.id, userId, role: "MEMBER" })
      .expect(201);
  }

  const key = projectKey(suffix);
  const proj = await request(server)
    .post("/projects")
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
    userIds,
    projectId: proj.body.id,
    projectKey: key,
  };
}

export async function createSprint(
  server: any,
  projectId: number,
  daysAround = 7,
): Promise<number> {
  const today = new Date();
  const start = new Date(today.getTime() - daysAround * 86400000);
  const end = new Date(today.getTime() + daysAround * 86400000);
  const r = await request(server)
    .post("/sprints")
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
): Promise<number> {
  const r = await request(server)
    .post("/labels")
    .send({ projectId, name })
    .expect(201);
  return r.body.id;
}

export async function createIssue(
  server: any,
  body: Record<string, unknown>,
): Promise<{ id: number; number: number; version: number; status: string }> {
  const r = await request(server).post("/issues").send(body).expect(201);
  return r.body;
}
