/**
 * SQLite In-Memory JOIN 통합 테스트
 *
 * LEFT JOIN, INNER JOIN, CROSS JOIN, self-referencing JOIN,
 * multi-table JOIN, aliased columns, JOIN + aggregate 등
 * 복합 조인 시나리오를 SQLite in-memory에서 검증합니다.
 */

import "reflect-metadata";
import { SqliteConnector } from "../../../src/dialects/sqlite/SqliteConnector";
import { SqliteDriver } from "../../../src/dialects/sqlite/SqliteDriver";
import { DatabaseClientOptions } from "../../../src/core/DatabaseClientOptions";

describe("[Integration] SQLite In-Memory: JOIN 테스트", () => {
  let connector: SqliteConnector;
  let driver: SqliteDriver;

  beforeAll(async () => {
    connector = new SqliteConnector();
    await connector.connect({
      type: "sqlite",
      database: ":memory:",
      logging: false,
    } as DatabaseClientOptions);
    driver = new SqliteDriver(connector);

    // authors 테이블
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "authors" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL,
        "country" TEXT
      )
    `);

    // posts 테이블 (FK → authors.id)
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "posts" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL,
        "authorId" INTEGER,
        FOREIGN KEY ("authorId") REFERENCES "authors"("id") ON DELETE CASCADE
      )
    `);

    // comments 테이블 (FK → posts.id)
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "comments" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "body" TEXT NOT NULL,
        "postId" INTEGER,
        FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE
      )
    `);

    // employees 테이블 (self-referencing FK)
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "employees" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL,
        "managerId" INTEGER,
        FOREIGN KEY ("managerId") REFERENCES "employees"("id")
      )
    `);

    // tags 테이블
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "tags" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "label" TEXT NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await connector.close();
  });

  beforeEach(async () => {
    await connector.query('DELETE FROM "comments"');
    await connector.query('DELETE FROM "posts"');
    await connector.query('DELETE FROM "authors"');
    await connector.query('DELETE FROM "employees"');
    await connector.query('DELETE FROM "tags"');
  });

  // ─────────────────────────────────────────────────────────
  // Seed helper
  // ─────────────────────────────────────────────────────────

  async function seedAuthorsAndPosts() {
    const a1 = await connector.query(
      `INSERT INTO "authors" ("name", "country") VALUES ('Alice', 'KR')`,
    );
    const a2 = await connector.query(
      `INSERT INTO "authors" ("name", "country") VALUES ('Bob', 'US')`,
    );
    const a3 = await connector.query(
      `INSERT INTO "authors" ("name", "country") VALUES ('Charlie', 'KR')`,
    );

    const a1Id = Number(a1.lastInsertRowid);
    const a2Id = Number(a2.lastInsertRowid);
    const a3Id = Number(a3.lastInsertRowid);

    // Alice: 2 posts, Bob: 1 post, Charlie: 0 posts
    const p1 = await connector.query(
      `INSERT INTO "posts" ("title", "authorId") VALUES ('Post A1', ${a1Id})`,
    );
    const p2 = await connector.query(
      `INSERT INTO "posts" ("title", "authorId") VALUES ('Post A2', ${a1Id})`,
    );
    const p3 = await connector.query(
      `INSERT INTO "posts" ("title", "authorId") VALUES ('Post B1', ${a2Id})`,
    );
    // Orphan post (no author)
    await connector.query(
      `INSERT INTO "posts" ("title", "authorId") VALUES ('Orphan Post', NULL)`,
    );

    return {
      a1Id,
      a2Id,
      a3Id,
      p1Id: Number(p1.lastInsertRowid),
      p2Id: Number(p2.lastInsertRowid),
      p3Id: Number(p3.lastInsertRowid),
    };
  }

  // ─────────────────────────────────────────────────────────
  // LEFT JOIN
  // ─────────────────────────────────────────────────────────

  describe("LEFT JOIN", () => {
    it("should join posts with authors and return all posts", async () => {
      await seedAuthorsAndPosts();

      const rows = await connector.query(`
        SELECT p."title", a."name" as "authorName"
        FROM "posts" p
        LEFT JOIN "authors" a ON p."authorId" = a."id"
        ORDER BY p."id"
      `);

      expect(rows.length).toBe(4);
      expect(rows[0].authorName).toBe("Alice");
      expect(rows[1].authorName).toBe("Alice");
      expect(rows[2].authorName).toBe("Bob");
      expect(rows[3].authorName).toBeNull(); // orphan
    });

    it("should include authors with no posts via LEFT JOIN", async () => {
      await seedAuthorsAndPosts();

      const rows = await connector.query(`
        SELECT a."name", p."title"
        FROM "authors" a
        LEFT JOIN "posts" p ON a."id" = p."authorId"
        ORDER BY a."name", p."id"
      `);

      // Alice(2 posts) + Bob(1 post) + Charlie(0 posts, title=NULL)
      expect(rows.length).toBe(4);
      const charlie = rows.find((r: any) => r.name === "Charlie");
      expect(charlie).toBeDefined();
      expect(charlie.title).toBeNull();
    });

    it("should return empty right side when no matches exist", async () => {
      // Author with no posts at all
      await connector.query(
        `INSERT INTO "authors" ("name", "country") VALUES ('Lonely', 'JP')`,
      );

      const rows = await connector.query(`
        SELECT a."name", p."title"
        FROM "authors" a
        LEFT JOIN "posts" p ON a."id" = p."authorId"
      `);

      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Lonely");
      expect(rows[0].title).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────
  // INNER JOIN
  // ─────────────────────────────────────────────────────────

  describe("INNER JOIN", () => {
    it("should return only rows with matching FK", async () => {
      await seedAuthorsAndPosts();

      const rows = await connector.query(`
        SELECT p."title", a."name" as "authorName"
        FROM "posts" p
        INNER JOIN "authors" a ON p."authorId" = a."id"
        ORDER BY p."id"
      `);

      // Orphan post excluded
      expect(rows.length).toBe(3);
      expect(rows.every((r: any) => r.authorName !== null)).toBe(true);
    });

    it("should exclude authors with no posts", async () => {
      await seedAuthorsAndPosts();

      const rows = await connector.query(`
        SELECT a."name"
        FROM "authors" a
        INNER JOIN "posts" p ON a."id" = p."authorId"
        GROUP BY a."id"
        ORDER BY a."name"
      `);

      expect(rows.length).toBe(2); // Alice, Bob (Charlie excluded)
      expect(rows[0].name).toBe("Alice");
      expect(rows[1].name).toBe("Bob");
    });
  });

  // ─────────────────────────────────────────────────────────
  // Self-referencing JOIN
  // ─────────────────────────────────────────────────────────

  describe("Self-referencing JOIN", () => {
    it("should join employees with their managers", async () => {
      // CEO (no manager)
      const ceo = await connector.query(
        `INSERT INTO "employees" ("name", "managerId") VALUES ('CEO', NULL)`,
      );
      const ceoId = Number(ceo.lastInsertRowid);

      // VP reports to CEO
      const vp = await connector.query(
        `INSERT INTO "employees" ("name", "managerId") VALUES ('VP', ${ceoId})`,
      );
      const vpId = Number(vp.lastInsertRowid);

      // Engineers report to VP
      await connector.query(
        `INSERT INTO "employees" ("name", "managerId") VALUES ('Eng1', ${vpId})`,
      );
      await connector.query(
        `INSERT INTO "employees" ("name", "managerId") VALUES ('Eng2', ${vpId})`,
      );

      const rows = await connector.query(`
        SELECT e."name" as "employee", m."name" as "manager"
        FROM "employees" e
        LEFT JOIN "employees" m ON e."managerId" = m."id"
        ORDER BY e."id"
      `);

      expect(rows.length).toBe(4);
      expect(rows[0]).toEqual({ employee: "CEO", manager: null });
      expect(rows[1]).toEqual({ employee: "VP", manager: "CEO" });
      expect(rows[2]).toEqual({ employee: "Eng1", manager: "VP" });
      expect(rows[3]).toEqual({ employee: "Eng2", manager: "VP" });
    });

    it("should find all direct reports of a manager", async () => {
      const mgr = await connector.query(
        `INSERT INTO "employees" ("name", "managerId") VALUES ('Manager', NULL)`,
      );
      const mgrId = Number(mgr.lastInsertRowid);

      await connector.query(
        `INSERT INTO "employees" ("name", "managerId") VALUES ('Report1', ${mgrId})`,
      );
      await connector.query(
        `INSERT INTO "employees" ("name", "managerId") VALUES ('Report2', ${mgrId})`,
      );
      await connector.query(
        `INSERT INTO "employees" ("name", "managerId") VALUES ('Report3', ${mgrId})`,
      );

      const rows = await connector.query(`
        SELECT e."name"
        FROM "employees" e
        INNER JOIN "employees" m ON e."managerId" = m."id"
        WHERE m."name" = 'Manager'
        ORDER BY e."name"
      `);

      expect(rows.length).toBe(3);
      expect(rows.map((r: any) => r.name)).toEqual([
        "Report1",
        "Report2",
        "Report3",
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Multiple JOINs (3-table chain)
  // ─────────────────────────────────────────────────────────

  describe("Multiple JOINs", () => {
    it("should join 3 tables: authors → posts → comments", async () => {
      const { a1Id, p1Id, p3Id } = await seedAuthorsAndPosts();

      // Comments on post A1
      await connector.query(
        `INSERT INTO "comments" ("body", "postId") VALUES ('Great post!', ${p1Id})`,
      );
      await connector.query(
        `INSERT INTO "comments" ("body", "postId") VALUES ('Thanks!', ${p1Id})`,
      );
      // Comment on post B1
      await connector.query(
        `INSERT INTO "comments" ("body", "postId") VALUES ('Nice work', ${p3Id})`,
      );

      const rows = await connector.query(`
        SELECT a."name" as "author", p."title" as "post", c."body" as "comment"
        FROM "authors" a
        INNER JOIN "posts" p ON a."id" = p."authorId"
        INNER JOIN "comments" c ON p."id" = c."postId"
        ORDER BY a."name", p."title", c."id"
      `);

      expect(rows.length).toBe(3);
      expect(rows[0]).toEqual({
        author: "Alice",
        post: "Post A1",
        comment: "Great post!",
      });
      expect(rows[1]).toEqual({
        author: "Alice",
        post: "Post A1",
        comment: "Thanks!",
      });
      expect(rows[2]).toEqual({
        author: "Bob",
        post: "Post B1",
        comment: "Nice work",
      });
    });

    it("should handle 3-table LEFT JOIN with missing relations", async () => {
      const { a1Id, a3Id, p1Id } = await seedAuthorsAndPosts();

      // Only one comment on Post A1
      await connector.query(
        `INSERT INTO "comments" ("body", "postId") VALUES ('Only comment', ${p1Id})`,
      );

      const rows = await connector.query(`
        SELECT a."name" as "author", p."title" as "post", c."body" as "comment"
        FROM "authors" a
        LEFT JOIN "posts" p ON a."id" = p."authorId"
        LEFT JOIN "comments" c ON p."id" = c."postId"
        ORDER BY a."name", p."id"
      `);

      // Alice(Post A1 + comment, Post A2 no comment), Bob(Post B1 no comment), Charlie(no post)
      expect(rows.length >= 4).toBe(true);
      const charlie = rows.find((r: any) => r.author === "Charlie");
      expect(charlie?.post).toBeNull();
      expect(charlie?.comment).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────
  // Aliased columns
  // ─────────────────────────────────────────────────────────

  describe("Aliased columns", () => {
    it("should disambiguate same-named columns via aliases", async () => {
      await seedAuthorsAndPosts();

      const rows = await connector.query(`
        SELECT
          a."id" as "authorId",
          a."name" as "authorName",
          p."id" as "postId",
          p."title" as "postTitle"
        FROM "posts" p
        INNER JOIN "authors" a ON p."authorId" = a."id"
        ORDER BY p."id"
        LIMIT 1
      `);

      expect(rows.length).toBe(1);
      expect(rows[0]).toHaveProperty("authorId");
      expect(rows[0]).toHaveProperty("authorName");
      expect(rows[0]).toHaveProperty("postId");
      expect(rows[0]).toHaveProperty("postTitle");
      // id values should differ
      expect(rows[0].authorId).not.toBe(rows[0].postId);
    });
  });

  // ─────────────────────────────────────────────────────────
  // JOIN + Aggregate
  // ─────────────────────────────────────────────────────────

  describe("JOIN + Aggregate", () => {
    it("should count posts per author using JOIN + GROUP BY", async () => {
      await seedAuthorsAndPosts();

      const rows = await connector.query(`
        SELECT a."name", COUNT(p."id") as "postCount"
        FROM "authors" a
        LEFT JOIN "posts" p ON a."id" = p."authorId"
        GROUP BY a."id"
        ORDER BY a."name"
      `);

      expect(rows.length).toBe(3);
      expect(rows[0]).toEqual({ name: "Alice", postCount: 2 });
      expect(rows[1]).toEqual({ name: "Bob", postCount: 1 });
      expect(rows[2]).toEqual({ name: "Charlie", postCount: 0 });
    });

    it("should filter groups with HAVING after JOIN", async () => {
      await seedAuthorsAndPosts();

      const rows = await connector.query(`
        SELECT a."name", COUNT(p."id") as "postCount"
        FROM "authors" a
        LEFT JOIN "posts" p ON a."id" = p."authorId"
        GROUP BY a."id"
        HAVING COUNT(p."id") >= 2
      `);

      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Alice");
      expect(rows[0].postCount).toBe(2);
    });

    it("should compute SUM across joined tables", async () => {
      // Create products table for numeric aggregation
      await connector.query(`
        CREATE TABLE IF NOT EXISTS "categories" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "name" TEXT NOT NULL
        )
      `);
      await connector.query(`
        CREATE TABLE IF NOT EXISTS "products" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "name" TEXT NOT NULL,
          "price" REAL NOT NULL,
          "categoryId" INTEGER,
          FOREIGN KEY ("categoryId") REFERENCES "categories"("id")
        )
      `);

      const cat1 = await connector.query(
        `INSERT INTO "categories" ("name") VALUES ('Electronics')`,
      );
      const cat2 = await connector.query(
        `INSERT INTO "categories" ("name") VALUES ('Books')`,
      );
      const cat1Id = Number(cat1.lastInsertRowid);
      const cat2Id = Number(cat2.lastInsertRowid);

      await connector.query(
        `INSERT INTO "products" ("name", "price", "categoryId") VALUES ('Laptop', 999.99, ${cat1Id})`,
      );
      await connector.query(
        `INSERT INTO "products" ("name", "price", "categoryId") VALUES ('Phone', 499.99, ${cat1Id})`,
      );
      await connector.query(
        `INSERT INTO "products" ("name", "price", "categoryId") VALUES ('Book A', 19.99, ${cat2Id})`,
      );

      const rows = await connector.query(`
        SELECT c."name" as "category", SUM(p."price") as "total"
        FROM "categories" c
        INNER JOIN "products" p ON c."id" = p."categoryId"
        GROUP BY c."id"
        ORDER BY "total" DESC
      `);

      expect(rows.length).toBe(2);
      expect(rows[0].category).toBe("Electronics");
      expect(rows[0].total).toBeCloseTo(1499.98, 1);
      expect(rows[1].category).toBe("Books");
      expect(rows[1].total).toBeCloseTo(19.99, 1);

      // Cleanup
      await connector.query('DROP TABLE IF EXISTS "products"');
      await connector.query('DROP TABLE IF EXISTS "categories"');
    });
  });

  // ─────────────────────────────────────────────────────────
  // JOIN + ORDER BY + LIMIT
  // ─────────────────────────────────────────────────────────

  describe("JOIN + ORDER BY + LIMIT", () => {
    it("should paginate joined results with LIMIT and OFFSET", async () => {
      await seedAuthorsAndPosts();

      const page1 = await connector.query(`
        SELECT p."title", a."name" as "author"
        FROM "posts" p
        INNER JOIN "authors" a ON p."authorId" = a."id"
        ORDER BY p."id"
        LIMIT 2 OFFSET 0
      `);

      const page2 = await connector.query(`
        SELECT p."title", a."name" as "author"
        FROM "posts" p
        INNER JOIN "authors" a ON p."authorId" = a."id"
        ORDER BY p."id"
        LIMIT 2 OFFSET 2
      `);

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(1); // only 3 posts with authors
      // No overlap
      const allTitles = [...page1, ...page2].map((r: any) => r.title);
      expect(new Set(allTitles).size).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────
  // CROSS JOIN
  // ─────────────────────────────────────────────────────────

  describe("CROSS JOIN", () => {
    it("should produce cartesian product", async () => {
      await connector.query(
        `INSERT INTO "authors" ("name") VALUES ('A1')`,
      );
      await connector.query(
        `INSERT INTO "authors" ("name") VALUES ('A2')`,
      );
      await connector.query(
        `INSERT INTO "tags" ("label") VALUES ('T1')`,
      );
      await connector.query(
        `INSERT INTO "tags" ("label") VALUES ('T2')`,
      );
      await connector.query(
        `INSERT INTO "tags" ("label") VALUES ('T3')`,
      );

      const rows = await connector.query(`
        SELECT a."name", t."label"
        FROM "authors" a
        CROSS JOIN "tags" t
        ORDER BY a."name", t."label"
      `);

      // 2 authors × 3 tags = 6
      expect(rows.length).toBe(6);
      expect(rows[0]).toEqual({ name: "A1", label: "T1" });
      expect(rows[5]).toEqual({ name: "A2", label: "T3" });
    });
  });
});
