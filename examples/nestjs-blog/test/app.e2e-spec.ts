import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "../src/app.module";

/**
 * nestjs-blog E2E Integration Tests
 *
 * Requires a running MySQL database.
 * Set INTEGRATION_TEST=true to run:
 *   INTEGRATION_TEST=true pnpm test
 */

const skipReason = !process.env.INTEGRATION_TEST
  ? "INTEGRATION_TEST 환경변수가 설정되지 않음"
  : undefined;

const describeIf = skipReason ? describe.skip : describe;

/** Small delay between tests to let MySQL connection pool recycle properly */
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describeIf("[E2E] nestjs-blog API", () => {
  let app: INestApplication;
  let server: any;

  // Shared IDs across tests
  let userId: number;
  let userId2: number;
  let categoryId: number;
  let categoryId2: number;
  let tagId: number;
  let tagId2: number;
  let tagId3: number;
  let postId: number;
  let postId2: number;

  beforeAll(async () => {
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
    if (app) {
      await app.close();
    }
  }, 30000);

  // ===========================
  // App Root
  // ===========================
  describe("App Root", () => {
    it("GET / — should return hello message", async () => {
      const res = await request(server).get("/");
      expect(res.status).toBe(200);
      expect(typeof res.text).toBe("string");
    });

    it("GET /schema/diff — should run a real diff against the live DB", async () => {
      const res = await request(server).get("/schema/diff");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("inSync");
      expect(res.body).toHaveProperty("diff");
      expect(res.body.diff).toHaveProperty("addTables");
      expect(res.body.diff).toHaveProperty("addColumns");
      expect(res.body.diff).toHaveProperty("alterColumns");
      expect(res.body).toHaveProperty("migrationPreview");
      // The app boots with synchronize: true, so the just-synced entities
      // must not report missing tables.
      expect(res.body.diff.addTables).toEqual([]);
    });
  });

  // ===========================
  // Users CRUD
  // ===========================
  describe("Users", () => {
    const ts = Date.now();

    it("POST /users — should create first user", async () => {
      const res = await request(server)
        .post("/users")
        .send({ username: `testuser_${ts}`, email: `test_${ts}@example.com`, bio: "Hello" });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.username).toBe(`testuser_${ts}`);
      expect(res.body.email).toBe(`test_${ts}@example.com`);
      userId = res.body.id;
      await wait();
    });

    it("POST /users — should create second user", async () => {
      const res = await request(server)
        .post("/users")
        .send({ username: `testuser2_${ts}`, email: `test2_${ts}@example.com` });
      expect(res.status).toBe(201);
      userId2 = res.body.id;
      await wait();
    });

    it("GET /users — should return all users", async () => {
      const res = await request(server).get("/users");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it("GET /users/:id — should return a specific user", async () => {
      const res = await request(server).get(`/users/${userId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(userId);
      expect(res.body.username).toBe(`testuser_${ts}`);
    });

    it("GET /users/:id — should return 404 for non-existent user", async () => {
      const res = await request(server).get("/users/999999");
      expect(res.status).toBe(404);
    });

    it("PATCH /users/:id — should update a user", async () => {
      await wait();
      const res = await request(server)
        .patch(`/users/${userId}`)
        .send({ bio: "Updated bio" });
      expect(res.status).toBe(200);
      expect(res.body.bio).toBe("Updated bio");
      await wait();
    });

    it("GET /users/count — should return user count", async () => {
      const res = await request(server).get("/users/count");
      expect(res.status).toBe(200);
      expect(Number(res.text)).toBeGreaterThanOrEqual(2);
    });

    it("GET /users/paginated — should return paginated users", async () => {
      const res = await request(server).get("/users/paginated?page=1&limit=10");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("total");
      expect(res.body).toHaveProperty("page");
      expect(res.body).toHaveProperty("totalPages");
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.page).toBe(1);
    });
  });

  // ===========================
  // Categories CRUD
  // ===========================
  describe("Categories", () => {
    const ts = Date.now();

    it("POST /categories — should create first category", async () => {
      await wait();
      const res = await request(server)
        .post("/categories")
        .send({ name: `TestCategory_${ts}`, description: "A test category" });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe(`TestCategory_${ts}`);
      categoryId = res.body.id;
      await wait();
    });

    it("POST /categories — should create second category", async () => {
      const res = await request(server)
        .post("/categories")
        .send({ name: `TestCategory2_${ts}` });
      expect(res.status).toBe(201);
      categoryId2 = res.body.id;
      await wait();
    });

    it("GET /categories — should return all categories", async () => {
      const res = await request(server).get("/categories");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it("GET /categories/:id — should return a specific category", async () => {
      const res = await request(server).get(`/categories/${categoryId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(categoryId);
      expect(res.body.name).toBe(`TestCategory_${ts}`);
    });

    it("GET /categories/:id — should return 404 for non-existent category", async () => {
      const res = await request(server).get("/categories/999999");
      expect(res.status).toBe(404);
    });

    it("PATCH /categories/:id — should update a category", async () => {
      await wait();
      const res = await request(server)
        .patch(`/categories/${categoryId}`)
        .send({ description: "Updated description" });
      expect(res.status).toBe(200);
      expect(res.body.description).toBe("Updated description");
      await wait();
    });

    it("GET /categories/count — should return category count", async () => {
      const res = await request(server).get("/categories/count");
      expect(res.status).toBe(200);
      expect(Number(res.text)).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================
  // Tags CRUD
  // ===========================
  describe("Tags", () => {
    const ts = Date.now();

    it("POST /tags — should create first tag", async () => {
      await wait();
      const res = await request(server)
        .post("/tags")
        .send({ name: `tag_alpha_${ts}` });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe(`tag_alpha_${ts}`);
      tagId = res.body.id;
      await wait();
    });

    it("POST /tags — should create second tag", async () => {
      const res = await request(server)
        .post("/tags")
        .send({ name: `tag_beta_${ts}` });
      expect(res.status).toBe(201);
      tagId2 = res.body.id;
      await wait();
    });

    it("POST /tags — should create third tag", async () => {
      const res = await request(server)
        .post("/tags")
        .send({ name: `tag_gamma_${ts}` });
      expect(res.status).toBe(201);
      tagId3 = res.body.id;
      await wait();
    });

    it("GET /tags — should return all tags", async () => {
      const res = await request(server).get("/tags");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(3);
    });

    it("GET /tags/:id — should return a specific tag", async () => {
      const res = await request(server).get(`/tags/${tagId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(tagId);
    });

    it("GET /tags/:id — should return 404 for non-existent tag", async () => {
      const res = await request(server).get("/tags/999999");
      expect(res.status).toBe(404);
    });

    it("GET /tags/count — should return tag count", async () => {
      const res = await request(server).get("/tags/count");
      expect(res.status).toBe(200);
      expect(Number(res.text)).toBeGreaterThanOrEqual(3);
    });

    it("GET /tags/paginated — should return paginated tags", async () => {
      const res = await request(server).get("/tags/paginated?page=1&limit=2");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("total");
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it("POST /tags/upsert — should upsert a tag", async () => {
      await wait();
      const res = await request(server)
        .post("/tags/upsert")
        .send({ name: `tag_alpha_${ts}` });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("message");
      expect(res.body.message).toContain(`tag_alpha_${ts}`);
      await wait();
    });
  });

  // ===========================
  // Posts CRUD
  // ===========================
  describe("Posts", () => {
    const ts = Date.now();

    it("POST /posts — should create first post", async () => {
      await wait();
      const res = await request(server)
        .post("/posts")
        .send({
          title: `Test Post ${ts}`,
          slug: `test-post-${ts}`,
          content: "This is test content for the blog post.",
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.title).toBe(`Test Post ${ts}`);
      expect(res.body.slug).toBe(`test-post-${ts}`);
      postId = res.body.id;
      await wait();
    });

    it("POST /posts — should create second post", async () => {
      const res = await request(server)
        .post("/posts")
        .send({
          title: `Test Post 2 ${ts}`,
          slug: `test-post-2-${ts}`,
          content: "Second test post content.",
        });
      expect(res.status).toBe(201);
      postId2 = res.body.id;
      await wait();
    });

    it("GET /posts — should return all posts", async () => {
      const res = await request(server).get("/posts");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it("GET /posts/:id — should return a specific post", async () => {
      const res = await request(server).get(`/posts/${postId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(postId);
      expect(res.body.title).toBe(`Test Post ${ts}`);
    });

    it("GET /posts/:id — should return 404 for non-existent post", async () => {
      const res = await request(server).get("/posts/999999");
      expect(res.status).toBe(404);
    });

    it("PATCH /posts/:id — should update a post", async () => {
      await wait();
      const res = await request(server)
        .patch(`/posts/${postId}`)
        .send({ title: `Updated Post ${ts}`, content: "Updated content." });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe(`Updated Post ${ts}`);
      await wait();
    });

    it("GET /posts/paginated — should return paginated posts", async () => {
      const res = await request(server).get("/posts/paginated?page=1&limit=10");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("total");
      expect(res.body).toHaveProperty("page");
      expect(res.body).toHaveProperty("totalPages");
      expect(res.body.total).toBeGreaterThanOrEqual(2);
    });

    it("GET /posts/cursor — should return cursor-paginated posts", async () => {
      const res = await request(server).get("/posts/cursor?take=10");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(Array.isArray(res.body.data)).toBe(true);
      // Response shape: { data, hasNextPage, nextCursor, count }
      expect(res.body).toHaveProperty("hasNextPage");
    });

    it("GET /posts/cursor — cursor pagination with cursor param", async () => {
      // First page
      const page1 = await request(server).get("/posts/cursor?take=1");
      expect(page1.status).toBe(200);
      expect(page1.body.data.length).toBe(1);

      if (page1.body.nextCursor) {
        await wait(100);
        // Second page
        const page2 = await request(server)
          .get(`/posts/cursor?take=1&cursor=${page1.body.nextCursor}`);
        expect(page2.status).toBe(200);
        expect(page2.body.data.length).toBe(1);
        expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
      }
    });
  });

  // ===========================
  // Post Soft Delete
  // ===========================
  describe("Posts — Soft Delete", () => {
    it("PATCH /posts/:id/soft-delete — should soft-delete a post", async () => {
      await wait();
      const res = await request(server).patch(`/posts/${postId2}/soft-delete`);
      expect(res.status).toBe(200);
      await wait();
    });

    it("GET /posts — soft-deleted post should not appear in normal list", async () => {
      await wait();
      const res = await request(server).get("/posts");
      expect(res.status).toBe(200);
      const ids = res.body.map((p: any) => p.id);
      expect(ids).not.toContain(postId2);
    });

    it("GET /posts/all — soft-deleted post should appear with withDeleted", async () => {
      const res = await request(server).get("/posts/all");
      expect(res.status).toBe(200);
      const ids = res.body.map((p: any) => p.id);
      expect(ids).toContain(postId2);
    });

    it("PATCH /posts/:id/restore — should restore a soft-deleted post", async () => {
      await wait();
      const res = await request(server).patch(`/posts/${postId2}/restore`);
      expect(res.status).toBe(200);
      await wait();
    });

    it("GET /posts — restored post should appear again", async () => {
      await wait();
      const res = await request(server).get("/posts");
      expect(res.status).toBe(200);
      const ids = res.body.map((p: any) => p.id);
      expect(ids).toContain(postId2);
    });
  });

  // ===========================
  // Post Upsert
  // ===========================
  describe("Posts — Upsert", () => {
    it("POST /posts/upsert — should upsert a post by slug", async () => {
      await wait();
      const ts2 = Date.now();
      const res = await request(server)
        .post("/posts/upsert")
        .send({
          title: `Upsert Post ${ts2}`,
          slug: `upsert-slug-${ts2}`,
          content: "Upsert content",
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("message");
      expect(res.body.message).toContain(`upsert-slug-${ts2}`);

      await wait();

      // Upsert again with same slug — should not fail
      const res2 = await request(server)
        .post("/posts/upsert")
        .send({
          title: `Upsert Updated ${ts2}`,
          slug: `upsert-slug-${ts2}`,
          content: "Updated upsert content",
        });
      expect(res2.status).toBe(201);
      expect(res2.body.message).toContain(`upsert-slug-${ts2}`);
      await wait();
    });
  });

  // ===========================
  // Post-Tag ManyToMany
  // ===========================
  describe("Posts — Tags (ManyToMany)", () => {
    it("POST /posts/:id/tags — should add first tag to post", async () => {
      await wait();
      const res = await request(server)
        .post(`/posts/${postId}/tags`)
        .send({ tagId });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("message");
      expect(res.body.message).toContain(`Tag ${tagId}`);
      await wait();
    });

    it("POST /posts/:id/tags — should add second tag to post", async () => {
      const res = await request(server)
        .post(`/posts/${postId}/tags`)
        .send({ tagId: tagId2 });
      expect(res.status).toBe(201);
      await wait();
    });

    it("GET /posts/:id/tags — should return tags for a post", async () => {
      const res = await request(server).get(`/posts/${postId}/tags`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      const tagIds = res.body.map((t: any) => t.id);
      expect(tagIds).toContain(tagId);
      expect(tagIds).toContain(tagId2);
    });

    it("DELETE /posts/:id/tags/:tagId — should remove a tag from post", async () => {
      await wait();
      const res = await request(server).delete(`/posts/${postId}/tags/${tagId2}`);
      expect(res.status).toBe(200);
      expect(res.body.message).toContain(`Tag ${tagId2}`);
      await wait();
    });

    it("GET /posts/:id/tags — removed tag should no longer appear", async () => {
      const res = await request(server).get(`/posts/${postId}/tags`);
      expect(res.status).toBe(200);
      const tagIds = res.body.map((t: any) => t.id);
      expect(tagIds).not.toContain(tagId2);
      expect(tagIds).toContain(tagId);
    });
  });

  // ===========================
  // Category Stats (GROUP BY + HAVING)
  // ===========================
  describe("Categories — Stats", () => {
    it("GET /categories/stats — should return category stats", async () => {
      const res = await request(server).get("/categories/stats");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ===========================
  // Post EXPLAIN
  // ===========================
  describe("Posts — Explain Query", () => {
    it("GET /posts/:id/explain — should return query execution plan", async () => {
      const res = await request(server).get(`/posts/${postId}/explain`);
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });
  });

  // ===========================
  // Cleanup — DELETE operations
  // ===========================
  describe("Cleanup", () => {
    it("DELETE /posts/:id — should hard-delete first post", async () => {
      await wait();
      const res = await request(server).delete(`/posts/${postId}`);
      expect(res.status).toBe(200);

      await wait();
      // Verify it's gone
      const check = await request(server).get(`/posts/${postId}`);
      expect(check.status).toBe(404);
      postId = 0;
      await wait();
    });

    it("DELETE /posts/:id — should hard-delete second post", async () => {
      const res = await request(server).delete(`/posts/${postId2}`);
      expect(res.status).toBe(200);
      postId2 = 0;
      await wait();
    });

    it("DELETE /tags/:id — should delete first tag", async () => {
      const res = await request(server).delete(`/tags/${tagId}`);
      expect(res.status).toBe(200);
      tagId = 0;
      await wait();
    });

    it("DELETE /tags/:id — should delete second tag", async () => {
      const res = await request(server).delete(`/tags/${tagId2}`);
      expect(res.status).toBe(200);
      tagId2 = 0;
      await wait();
    });

    it("DELETE /tags/:id — should delete third tag", async () => {
      const res = await request(server).delete(`/tags/${tagId3}`);
      expect(res.status).toBe(200);
      tagId3 = 0;
      await wait();
    });

    it("DELETE /categories/:id — should delete first category", async () => {
      const res = await request(server).delete(`/categories/${categoryId}`);
      expect(res.status).toBe(200);
      categoryId = 0;
      await wait();
    });

    it("DELETE /categories/:id — should delete second category", async () => {
      const res = await request(server).delete(`/categories/${categoryId2}`);
      expect(res.status).toBe(200);
      categoryId2 = 0;
      await wait();
    });

    it("DELETE /users/:id — should delete first user", async () => {
      const res = await request(server).delete(`/users/${userId}`);
      expect(res.status).toBe(200);
      userId = 0;
      await wait();
    });

    it("DELETE /users/:id — should delete second user", async () => {
      const res = await request(server).delete(`/users/${userId2}`);
      expect(res.status).toBe(200);
      userId2 = 0;
    });
  });
});
