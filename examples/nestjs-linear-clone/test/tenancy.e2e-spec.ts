import * as request from "supertest";
import { MetadataContext } from "@stingerloom/orm";
import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  authedAgent,
  uniqueSuffix,
  projectKey,
  BootedApp,
} from "./helpers/test-app";
import { IssuesService } from "../src/modules/issues/issues.service";

interface TenantWorld {
  workspaceId: number;
  ownerId: number;
  ownerToken: string;
  projectId: number;
  /** Issue tree: A → B → C (depth 3). */
  rootId: number;
  midId: number;
  leafId: number;
}

/**
 * Build an isolated workspace + owner + project + 3-deep issue tree under
 * a fresh slug/key so each tenant fixture is independent of the others.
 * Used to construct the acme + globex pair that drives every cross-tenant
 * assertion in this file.
 */
async function provisionTenant(
  server: any,
  label: string,
): Promise<TenantWorld> {
  const suffix = uniqueSuffix(label.toLowerCase());

  const reg = await request(server)
    .post("/auth/register")
    .send({
      email: `owner-${suffix}@${label}.test`,
      name: `${label}-owner`,
      password: "fixture-password-123",
    })
    .expect(201);

  const ownerId = reg.body.user.id;
  const ownerToken = reg.body.accessToken as string;

  const ws = await request(server)
    .post("/workspaces")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      name: `${label} ${suffix}`,
      slug: `${label}-${suffix}`.slice(0, 39),
    })
    .expect(201);

  const proj = await request(server)
    .post("/projects")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      workspaceId: ws.body.id,
      name: `${label} platform ${suffix}`,
      key: projectKey(suffix),
    })
    .expect(201);

  const root = await request(server)
    .post("/issues")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      projectId: proj.body.id,
      title: `${label} root issue: deadlock retry`,
      status: "BACKLOG",
    })
    .expect(201);

  const mid = await request(server)
    .post("/issues")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      projectId: proj.body.id,
      title: `${label} mid issue`,
      status: "BACKLOG",
      parentId: root.body.id,
    })
    .expect(201);

  const leaf = await request(server)
    .post("/issues")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      projectId: proj.body.id,
      title: `${label} leaf issue`,
      status: "BACKLOG",
      parentId: mid.body.id,
    })
    .expect(201);

  return {
    workspaceId: ws.body.id,
    ownerId,
    ownerToken,
    projectId: proj.body.id,
    rootId: root.body.id,
    midId: mid.body.id,
    leafId: leaf.body.id,
  };
}

integrationDescribe("[E2E] Multi-tenancy — MetadataContext frame + cross-tenant invisibility", () => {
  let booted: BootedApp;
  let acme: TenantWorld;
  let globex: TenantWorld;
  let acmeApi: ReturnType<typeof authedAgent>;

  beforeAll(async () => {
    booted = await bootApp();
    acme = await provisionTenant(booted.server, "acme");
    globex = await provisionTenant(booted.server, "globex");
    acmeApi = authedAgent(booted.server, acme.ownerToken);
  }, 120000);

  afterAll(async () => {
    await shutdownApp(booted);
  }, 30000);

  // ────────────────────────────────────────────────
  // MetadataContext frame is opened per request
  // ────────────────────────────────────────────────
  describe("MetadataContext frame", () => {
    it("MetadataContext.getCurrentTenant() falls back to 'public' outside any HTTP frame", () => {
      // Calling getCurrentTenant() with no active run() block must not throw
      // and must report the public layer — services invoked outside a request
      // (CLI, seeders, background jobs) need that fallback.
      expect(MetadataContext.getCurrentTenant()).toBe("public");
      expect(MetadataContext.isActive()).toBe(false);
    });

    it("services keep working when invoked without a MetadataContext frame", async () => {
      // Direct service-layer call from outside a request: the absence of a
      // tenant frame must NOT crash the service. Data isolation in this
      // example still comes from the workspace_id column, so the call path
      // is just the ORM's normal queries running under the public layer.
      const issuesService = booted.app.get(IssuesService);
      const issue = await issuesService.findOne(acme.rootId);
      expect(issue.id).toBe(acme.rootId);
      expect(issue.title).toContain("acme");
    });
  });

  // ────────────────────────────────────────────────
  // findOne isolation — WorkspaceMemberGuard (403 from cross-tenant)
  // ────────────────────────────────────────────────
  describe("Cross-tenant findOne", () => {
    it("alice (acme) cannot GET a globex issue by id", async () => {
      const res = await acmeApi.get(`/issues/${globex.rootId}`);
      // WorkspaceMemberGuard runs before the ORM and rejects with 403 because
      // alice has no membership in globex's workspace. The ORM never sees
      // the query, which is exactly the behavior we want to verify.
      expect(res.status).toBe(403);
    });

    it("alice (acme) sees her own issue normally", async () => {
      const res = await acmeApi.get(`/issues/${acme.rootId}`).expect(200);
      expect(res.body.id).toBe(acme.rootId);
    });
  });

  // ────────────────────────────────────────────────
  // List isolation — current behavior at /issues?projectId=...
  // ────────────────────────────────────────────────
  describe("Cross-tenant list", () => {
    it("alice's project-filtered list never contains globex issues even when she queries her own project", async () => {
      const res = await acmeApi
        .get("/issues")
        .query({ projectId: acme.projectId })
        .expect(200);

      const ids = (res.body as { id: number; projectId: number }[]).map(
        (r) => r.id,
      );
      expect(ids).toContain(acme.rootId);
      expect(ids).not.toContain(globex.rootId);
      expect(ids).not.toContain(globex.midId);
      expect(ids).not.toContain(globex.leafId);
    });
  });

  // ────────────────────────────────────────────────
  // Search isolation — full-text + custom-field
  // ────────────────────────────────────────────────
  describe("Cross-tenant search", () => {
    it("acme full-text search does not return globex issues with the same matching term", async () => {
      // Both tenants seeded an issue containing "deadlock retry" so a
      // workspace-aware filter is the only thing keeping them apart.
      // Scoping by `projectId=acme.projectId` is the path the controller
      // actually exposes; combined with WorkspaceMemberGuard semantics,
      // alice cannot enumerate other tenants via /search.
      const res = await acmeApi
        .get("/search/issues")
        .query({ q: "deadlock retry", projectId: acme.projectId })
        .expect(200);

      const ids = (res.body as { id: number }[]).map((r) => r.id);
      expect(ids).not.toContain(globex.rootId);
    });
  });

  // ────────────────────────────────────────────────
  // Analytics isolation — recursive CTE
  // ────────────────────────────────────────────────
  describe("Cross-tenant analytics (recursive CTE)", () => {
    it("acme owner can walk her own tree", async () => {
      const res = await acmeApi
        .get(`/analytics/issues/${acme.rootId}/tree`)
        .expect(200);

      const ids = (res.body as { id: number }[]).map((r) => r.id);
      expect(ids).toEqual(
        expect.arrayContaining([acme.rootId, acme.midId, acme.leafId]),
      );
      // No globex node ever appears even in a permissive recursive CTE
      // because the seed root is acme's and the join filters via parent_id
      // never bridge across the workspace boundary.
      expect(ids).not.toContain(globex.rootId);
      expect(ids).not.toContain(globex.midId);
      expect(ids).not.toContain(globex.leafId);
    });

    it("acme owner cannot start a tree walk from a globex root", async () => {
      const res = await acmeApi.get(
        `/analytics/issues/${globex.rootId}/tree`,
      );
      // WorkspaceScoped({from:'issue'}) on the analytics handler resolves
      // the issue's workspace and rejects non-members with 403 before any
      // SQL runs.
      expect(res.status).toBe(403);
    });

    it("acme tree depth matches the seeded chain (root + mid + leaf = 3 rows)", async () => {
      const res = await acmeApi
        .get(`/analytics/issues/${acme.rootId}/tree`)
        .expect(200);

      const rows = res.body as { id: number; depth: number }[];
      expect(rows.length).toBe(3);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(acme.rootId)?.depth).toBe(0);
      expect(byId.get(acme.midId)?.depth).toBe(1);
      expect(byId.get(acme.leafId)?.depth).toBe(2);
    });
  });
});
