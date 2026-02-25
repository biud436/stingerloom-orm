import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { Pool } from "pg";
import { AppModule } from "../src/app.module";

/**
 * nestjs-multitenant E2E Integration Tests
 *
 * Requires a running PostgreSQL database.
 * Set INTEGRATION_TEST=true to run:
 *   INTEGRATION_TEST=true pnpm test:e2e
 *
 * Tests verify:
 * 1. TenantMiddleware automatically sets tenant context via AsyncLocalStorage
 * 2. TenantContext injectable service returns correct tenant
 * 3. @Tenant() decorator extracts tenant from context
 * 4. Real PostgreSQL schema-based data isolation between tenants
 * 5. CRUD operations work correctly within each tenant's schema
 */

const skipReason = !process.env.INTEGRATION_TEST
  ? "INTEGRATION_TEST 환경변수가 설정되지 않음"
  : undefined;

const describeIf = skipReason ? describe.skip : describe;

const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describeIf("[E2E] nestjs-multitenant API", () => {
  let app: INestApplication;
  let server: any;
  let pool: Pool;

  const ts = Date.now();

  // Shared IDs per tenant
  let tenantAUserId: number;
  let tenantBUserId: number;
  let publicUserId: number;
  let tenantAPostId: number;

  beforeAll(async () => {
    // Direct pool for schema cleanup
    pool = new Pool({
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432"),
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      database: process.env.DB_NAME || "multi_tenancy_db2",
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Wait for ORM bootstrap (DB connection + schema sync)
    await wait(3000);

    server = app.getHttpServer();
  }, 30000);

  afterAll(async () => {
    // Drop tenant schemas to clean up
    try {
      await pool.query('DROP SCHEMA IF EXISTS "tenant_a" CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS "tenant_b" CASCADE');
    } catch {
      // ignore cleanup errors
    }

    if (app) {
      await app.close();
    }
    if (pool) {
      await pool.end();
    }
  }, 30000);

  // ===========================
  // Tenant Context Verification
  // ===========================
  describe("Tenant Context", () => {
    it("GET /tenant/current — should return 'public' when no header", async () => {
      const res = await request(server).get("/tenant/current");
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBe("public");
      expect(res.body.isActive).toBe(true);
    });

    it("GET /tenant/current — should return tenant_a when header set", async () => {
      const res = await request(server)
        .get("/tenant/current")
        .set("x-tenant-id", "tenant_a");
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBe("tenant_a");
      expect(res.body.isActive).toBe(true);
    });

    it("GET /tenant/current — should return tenant_b when header set", async () => {
      const res = await request(server)
        .get("/tenant/current")
        .set("x-tenant-id", "tenant_b");
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBe("tenant_b");
      expect(res.body.isActive).toBe(true);
    });
  });

  // ===========================
  // Tenant A — Users CRUD
  // ===========================
  describe("Tenant A — Users", () => {
    it("POST /users — should create user in tenant_a", async () => {
      const res = await request(server)
        .post("/users")
        .set("x-tenant-id", "tenant_a")
        .send({
          username: `alice_${ts}`,
          email: `alice_${ts}@tenant-a.com`,
          bio: "Tenant A user",
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.username).toBe(`alice_${ts}`);
      tenantAUserId = res.body.id;
      await wait();
    });

    it("GET /users — should see user in tenant_a", async () => {
      const res = await request(server)
        .get("/users")
        .set("x-tenant-id", "tenant_a");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const usernames = res.body.map((u: any) => u.username);
      expect(usernames).toContain(`alice_${ts}`);
    });

    it("GET /users/:id — should find tenant_a user", async () => {
      const res = await request(server)
        .get(`/users/${tenantAUserId}`)
        .set("x-tenant-id", "tenant_a");
      expect(res.status).toBe(200);
      expect(res.body.username).toBe(`alice_${ts}`);
    });
  });

  // ===========================
  // Tenant B — Users CRUD
  // ===========================
  describe("Tenant B — Users", () => {
    it("POST /users — should create user in tenant_b", async () => {
      const res = await request(server)
        .post("/users")
        .set("x-tenant-id", "tenant_b")
        .send({
          username: `bob_${ts}`,
          email: `bob_${ts}@tenant-b.com`,
          bio: "Tenant B user",
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.username).toBe(`bob_${ts}`);
      tenantBUserId = res.body.id;
      await wait();
    });

    it("GET /users — should see user in tenant_b", async () => {
      const res = await request(server)
        .get("/users")
        .set("x-tenant-id", "tenant_b");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const usernames = res.body.map((u: any) => u.username);
      expect(usernames).toContain(`bob_${ts}`);
    });
  });

  // ===========================
  // Public Tenant — Users CRUD
  // ===========================
  describe("Public Tenant — Users", () => {
    it("POST /users — should create user in public tenant (no header)", async () => {
      const res = await request(server)
        .post("/users")
        .send({
          username: `public_user_${ts}`,
          email: `public_${ts}@example.com`,
          bio: "Public tenant user",
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      publicUserId = res.body.id;
      await wait();
    });

    it("GET /users — public tenant should see public user", async () => {
      const res = await request(server).get("/users");
      expect(res.status).toBe(200);
      const usernames = res.body.map((u: any) => u.username);
      expect(usernames).toContain(`public_user_${ts}`);
    });
  });

  // ===========================
  // Cross-Tenant Data Isolation
  // ===========================
  describe("Cross-Tenant Data Isolation (Schema-Based)", () => {
    it("tenant_a list should NOT contain tenant_b username", async () => {
      const res = await request(server)
        .get("/users")
        .set("x-tenant-id", "tenant_a");
      expect(res.status).toBe(200);
      const usernames = res.body.map((u: any) => u.username);
      expect(usernames).toContain(`alice_${ts}`);
      expect(usernames).not.toContain(`bob_${ts}`);
      expect(usernames).not.toContain(`public_user_${ts}`);
    });

    it("tenant_b list should NOT contain tenant_a username", async () => {
      const res = await request(server)
        .get("/users")
        .set("x-tenant-id", "tenant_b");
      expect(res.status).toBe(200);
      const usernames = res.body.map((u: any) => u.username);
      expect(usernames).toContain(`bob_${ts}`);
      expect(usernames).not.toContain(`alice_${ts}`);
      expect(usernames).not.toContain(`public_user_${ts}`);
    });

    it("public tenant should NOT contain tenant-specific data", async () => {
      const res = await request(server).get("/users");
      expect(res.status).toBe(200);
      const usernames = res.body.map((u: any) => u.username);
      expect(usernames).toContain(`public_user_${ts}`);
      expect(usernames).not.toContain(`alice_${ts}`);
      expect(usernames).not.toContain(`bob_${ts}`);
    });

    it("tenant_b should NOT find tenant_a user by ID", async () => {
      const res = await request(server)
        .get(`/users/${tenantAUserId}`)
        .set("x-tenant-id", "tenant_b");
      // Schema isolation: tenant_a's user ID doesn't exist in tenant_b schema
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        // If found by ID, it must be a different user (independent sequences)
        expect(res.body.username).not.toBe(`alice_${ts}`);
      }
    });
  });

  // ===========================
  // Tenant A — Posts CRUD
  // ===========================
  describe("Tenant A — Posts", () => {
    it("POST /posts — should create post in tenant_a", async () => {
      const res = await request(server)
        .post("/posts")
        .set("x-tenant-id", "tenant_a")
        .send({
          title: `Tenant A Post ${ts}`,
          content: "Content from tenant A",
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.title).toBe(`Tenant A Post ${ts}`);
      tenantAPostId = res.body.id;
      await wait();
    });

    it("GET /posts — should list posts in tenant_a", async () => {
      const res = await request(server)
        .get("/posts")
        .set("x-tenant-id", "tenant_a");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const titles = res.body.map((p: any) => p.title);
      expect(titles).toContain(`Tenant A Post ${ts}`);
    });

    it("GET /posts — tenant_b should NOT see tenant_a posts", async () => {
      const res = await request(server)
        .get("/posts")
        .set("x-tenant-id", "tenant_b");
      expect(res.status).toBe(200);
      const titles = res.body.map((p: any) => p.title);
      expect(titles).not.toContain(`Tenant A Post ${ts}`);
    });

    it("GET /posts/:id — should find tenant_a post", async () => {
      const res = await request(server)
        .get(`/posts/${tenantAPostId}`)
        .set("x-tenant-id", "tenant_a");
      expect(res.status).toBe(200);
      expect(res.body.title).toBe(`Tenant A Post ${ts}`);
    });

    it("PATCH /posts/:id — should update post in tenant_a", async () => {
      await wait();
      const res = await request(server)
        .patch(`/posts/${tenantAPostId}`)
        .set("x-tenant-id", "tenant_a")
        .send({ title: `Updated A Post ${ts}` });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe(`Updated A Post ${ts}`);
      await wait();
    });
  });

  // ===========================
  // Users — Update
  // ===========================
  describe("Tenant A — User Update", () => {
    it("PATCH /users/:id — should update user in tenant_a", async () => {
      await wait();
      const res = await request(server)
        .patch(`/users/${tenantAUserId}`)
        .set("x-tenant-id", "tenant_a")
        .send({ bio: "Updated bio in tenant A" });
      expect(res.status).toBe(200);
      expect(res.body.bio).toBe("Updated bio in tenant A");
      await wait();
    });
  });

  // ===========================
  // Middleware Automatic Context
  // ===========================
  describe("Middleware Automatic Context", () => {
    it("should not require explicit withTenant() in service — middleware handles it", async () => {
      const res = await request(server)
        .post("/users")
        .set("x-tenant-id", "tenant_a")
        .send({
          username: `middleware_test_${ts}`,
          email: `mw_${ts}@tenant-a.com`,
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");

      // Cleanup
      await wait();
      await request(server)
        .delete(`/users/${res.body.id}`)
        .set("x-tenant-id", "tenant_a");
      await wait();
    });

    it("default tenant context should be 'public' when no header", async () => {
      const res = await request(server).get("/tenant/current");
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBe("public");
      expect(res.body.isActive).toBe(true);
    });
  });

  // ===========================
  // Error handling
  // ===========================
  describe("Error Handling", () => {
    it("GET /users/999999 — should return 404", async () => {
      const res = await request(server)
        .get("/users/999999")
        .set("x-tenant-id", "tenant_a");
      expect(res.status).toBe(404);
    });

    it("GET /posts/999999 — should return 404", async () => {
      const res = await request(server)
        .get("/posts/999999")
        .set("x-tenant-id", "tenant_a");
      expect(res.status).toBe(404);
    });
  });

  // ===========================
  // Schema Existence Verification
  // ===========================
  describe("Schema Existence Verification", () => {
    it("tenant_a schema should exist in PostgreSQL", async () => {
      const { rows } = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'tenant_a'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].schema_name).toBe("tenant_a");
    });

    it("tenant_b schema should exist in PostgreSQL", async () => {
      const { rows } = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'tenant_b'`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].schema_name).toBe("tenant_b");
    });

    it("tenant_a schema should have user and post tables", async () => {
      const { rows } = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'tenant_a' ORDER BY tablename`,
      );
      const tables = rows.map((r: any) => r.tablename);
      expect(tables).toContain("user");
      expect(tables).toContain("post");
    });

    it("tenant_a.user should contain only tenant_a data", async () => {
      const { rows } = await pool.query(
        `SELECT username FROM "tenant_a"."user"`,
      );
      const usernames = rows.map((r: any) => r.username);
      expect(usernames).toContain(`alice_${ts}`);
      expect(usernames).not.toContain(`bob_${ts}`);
      expect(usernames).not.toContain(`public_user_${ts}`);
    });

    it("public.user should contain only public data", async () => {
      const { rows } = await pool.query(
        `SELECT username FROM "public"."user"`,
      );
      const usernames = rows.map((r: any) => r.username);
      expect(usernames).toContain(`public_user_${ts}`);
      expect(usernames).not.toContain(`alice_${ts}`);
      expect(usernames).not.toContain(`bob_${ts}`);
    });
  });

  // ===========================
  // Cleanup
  // ===========================
  describe("Cleanup", () => {
    it("DELETE /posts/:id — should delete tenant_a post", async () => {
      if (!tenantAPostId) return;
      await wait();
      const res = await request(server)
        .delete(`/posts/${tenantAPostId}`)
        .set("x-tenant-id", "tenant_a");
      expect(res.status).toBe(200);
      tenantAPostId = 0;
      await wait();
    });

    it("DELETE /users/:id — should delete tenant_a user", async () => {
      if (!tenantAUserId) return;
      const res = await request(server)
        .delete(`/users/${tenantAUserId}`)
        .set("x-tenant-id", "tenant_a");
      expect(res.status).toBe(200);
      tenantAUserId = 0;
      await wait();
    });

    it("DELETE /users/:id — should delete tenant_b user", async () => {
      if (!tenantBUserId) return;
      const res = await request(server)
        .delete(`/users/${tenantBUserId}`)
        .set("x-tenant-id", "tenant_b");
      expect(res.status).toBe(200);
      tenantBUserId = 0;
      await wait();
    });

    it("DELETE /users/:id — should delete public user", async () => {
      if (!publicUserId) return;
      const res = await request(server).delete(`/users/${publicUserId}`);
      expect(res.status).toBe(200);
      publicUserId = 0;
      await wait();
    });
  });
});
