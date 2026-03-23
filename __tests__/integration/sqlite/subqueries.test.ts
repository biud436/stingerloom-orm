/**
 * SQLite In-Memory 서브쿼리 통합 테스트
 *
 * WHERE IN, EXISTS, NOT EXISTS, scalar subquery,
 * derived table (FROM subquery), correlated subquery,
 * nested subquery, CTE (WITH clause) 등을 검증합니다.
 */

import "reflect-metadata";
import { SqliteConnector } from "../../../src/dialects/sqlite/SqliteConnector";
import { SqliteDriver } from "../../../src/dialects/sqlite/SqliteDriver";
import { DatabaseClientOptions } from "../../../src/core/DatabaseClientOptions";

describe("[Integration] SQLite In-Memory: 서브쿼리 테스트", () => {
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

    await connector.query(`
      CREATE TABLE IF NOT EXISTS "authors" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL,
        "country" TEXT
      )
    `);

    await connector.query(`
      CREATE TABLE IF NOT EXISTS "posts" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL,
        "authorId" INTEGER,
        FOREIGN KEY ("authorId") REFERENCES "authors"("id") ON DELETE CASCADE
      )
    `);

    await connector.query(`
      CREATE TABLE IF NOT EXISTS "comments" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "body" TEXT NOT NULL,
        "postId" INTEGER,
        FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE
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
  });

  // ─────────────────────────────────────────────────────────
  // Seed helper
  // ─────────────────────────────────────────────────────────

  async function seed() {
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

    const p1 = await connector.query(
      `INSERT INTO "posts" ("title", "authorId") VALUES ('Post A1', ${a1Id})`,
    );
    const p2 = await connector.query(
      `INSERT INTO "posts" ("title", "authorId") VALUES ('Post A2', ${a1Id})`,
    );
    const p3 = await connector.query(
      `INSERT INTO "posts" ("title", "authorId") VALUES ('Post B1', ${a2Id})`,
    );

    const p1Id = Number(p1.lastInsertRowid);
    const p3Id = Number(p3.lastInsertRowid);

    await connector.query(
      `INSERT INTO "comments" ("body", "postId") VALUES ('Comment 1', ${p1Id})`,
    );
    await connector.query(
      `INSERT INTO "comments" ("body", "postId") VALUES ('Comment 2', ${p1Id})`,
    );
    await connector.query(
      `INSERT INTO "comments" ("body", "postId") VALUES ('Comment 3', ${p3Id})`,
    );

    return { a1Id, a2Id, a3Id: Number(a3.lastInsertRowid), p1Id, p2Id: Number(p2.lastInsertRowid), p3Id };
  }

  // ─────────────────────────────────────────────────────────
  // WHERE IN subquery
  // ─────────────────────────────────────────────────────────

  describe("WHERE IN subquery", () => {
    it("should filter rows using IN with a subquery", async () => {
      await seed();

      const rows = await connector.query(`
        SELECT p."title"
        FROM "posts" p
        WHERE p."authorId" IN (
          SELECT a."id" FROM "authors" a WHERE a."country" = 'KR'
        )
        ORDER BY p."title"
      `);

      // Only Alice's posts (Charlie has no posts)
      expect(rows.length).toBe(2);
      expect(rows[0].title).toBe("Post A1");
      expect(rows[1].title).toBe("Post A2");
    });

    it("should filter rows using NOT IN with a subquery", async () => {
      await seed();

      const rows = await connector.query(`
        SELECT a."name"
        FROM "authors" a
        WHERE a."id" NOT IN (
          SELECT DISTINCT p."authorId" FROM "posts" p WHERE p."authorId" IS NOT NULL
        )
        ORDER BY a."name"
      `);

      // Charlie has no posts
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Charlie");
    });
  });

  // ─────────────────────────────────────────────────────────
  // WHERE EXISTS / NOT EXISTS
  // ─────────────────────────────────────────────────────────

  describe("WHERE EXISTS / NOT EXISTS", () => {
    it("should find authors who have at least one post", async () => {
      await seed();

      const rows = await connector.query(`
        SELECT a."name"
        FROM "authors" a
        WHERE EXISTS (
          SELECT 1 FROM "posts" p WHERE p."authorId" = a."id"
        )
        ORDER BY a."name"
      `);

      expect(rows.length).toBe(2);
      expect(rows[0].name).toBe("Alice");
      expect(rows[1].name).toBe("Bob");
    });

    it("should find authors who have no posts", async () => {
      await seed();

      const rows = await connector.query(`
        SELECT a."name"
        FROM "authors" a
        WHERE NOT EXISTS (
          SELECT 1 FROM "posts" p WHERE p."authorId" = a."id"
        )
      `);

      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("Charlie");
    });
  });

  // ─────────────────────────────────────────────────────────
  // Scalar subquery in SELECT
  // ─────────────────────────────────────────────────────────

  describe("Scalar subquery in SELECT", () => {
    it("should compute count per author as a scalar subquery", async () => {
      await seed();

      const rows = await connector.query(`
        SELECT
          a."name",
          (SELECT COUNT(*) FROM "posts" p WHERE p."authorId" = a."id") as "postCount"
        FROM "authors" a
        ORDER BY a."name"
      `);

      expect(rows.length).toBe(3);
      expect(rows[0]).toEqual({ name: "Alice", postCount: 2 });
      expect(rows[1]).toEqual({ name: "Bob", postCount: 1 });
      expect(rows[2]).toEqual({ name: "Charlie", postCount: 0 });
    });
  });

  // ─────────────────────────────────────────────────────────
  // FROM clause derived table
  // ─────────────────────────────────────────────────────────

  describe("FROM clause derived table", () => {
    it("should query from a derived table (inline view)", async () => {
      await seed();

      const rows = await connector.query(`
        SELECT sub."authorId", sub."cnt"
        FROM (
          SELECT p."authorId", COUNT(*) as "cnt"
          FROM "posts" p
          WHERE p."authorId" IS NOT NULL
          GROUP BY p."authorId"
        ) sub
        WHERE sub."cnt" >= 2
      `);

      expect(rows.length).toBe(1);
      expect(rows[0].cnt).toBe(2); // Alice
    });
  });

  // ─────────────────────────────────────────────────────────
  // Correlated subquery
  // ─────────────────────────────────────────────────────────

  describe("Correlated subquery", () => {
    it("should find posts that have comments via correlated subquery", async () => {
      await seed();

      const rows = await connector.query(`
        SELECT p."title"
        FROM "posts" p
        WHERE EXISTS (
          SELECT 1 FROM "comments" c WHERE c."postId" = p."id"
        )
        ORDER BY p."title"
      `);

      // Post A1 (2 comments), Post B1 (1 comment)
      expect(rows.length).toBe(2);
      expect(rows[0].title).toBe("Post A1");
      expect(rows[1].title).toBe("Post B1");
    });

    it("should find posts with more than 1 comment via correlated subquery", async () => {
      await seed();

      const rows = await connector.query(`
        SELECT p."title"
        FROM "posts" p
        WHERE (
          SELECT COUNT(*) FROM "comments" c WHERE c."postId" = p."id"
        ) > 1
      `);

      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe("Post A1");
    });
  });

  // ─────────────────────────────────────────────────────────
  // Nested subquery
  // ─────────────────────────────────────────────────────────

  describe("Nested subquery", () => {
    it("should handle subquery inside subquery", async () => {
      await seed();

      // Find authors who wrote posts that have comments
      const rows = await connector.query(`
        SELECT a."name"
        FROM "authors" a
        WHERE a."id" IN (
          SELECT p."authorId"
          FROM "posts" p
          WHERE p."id" IN (
            SELECT c."postId" FROM "comments" c
          )
        )
        ORDER BY a."name"
      `);

      expect(rows.length).toBe(2);
      expect(rows[0].name).toBe("Alice");
      expect(rows[1].name).toBe("Bob");
    });
  });

  // ─────────────────────────────────────────────────────────
  // Subquery with JOIN inside
  // ─────────────────────────────────────────────────────────

  describe("Subquery with JOIN", () => {
    it("should use a subquery that contains a JOIN", async () => {
      await seed();

      const rows = await connector.query(`
        SELECT a."name"
        FROM "authors" a
        WHERE a."id" IN (
          SELECT DISTINCT p."authorId"
          FROM "posts" p
          INNER JOIN "comments" c ON p."id" = c."postId"
          WHERE c."body" LIKE '%Comment%'
        )
        ORDER BY a."name"
      `);

      expect(rows.length).toBe(2);
      expect(rows[0].name).toBe("Alice");
      expect(rows[1].name).toBe("Bob");
    });
  });

  // ─────────────────────────────────────────────────────────
  // CTE (WITH clause)
  // ─────────────────────────────────────────────────────────

  describe("CTE (WITH clause)", () => {
    it("should support basic CTE", async () => {
      await seed();

      const rows = await connector.query(`
        WITH "post_counts" AS (
          SELECT "authorId", COUNT(*) as "cnt"
          FROM "posts"
          WHERE "authorId" IS NOT NULL
          GROUP BY "authorId"
        )
        SELECT a."name", pc."cnt"
        FROM "authors" a
        INNER JOIN "post_counts" pc ON a."id" = pc."authorId"
        ORDER BY pc."cnt" DESC
      `);

      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual({ name: "Alice", cnt: 2 });
      expect(rows[1]).toEqual({ name: "Bob", cnt: 1 });
    });

    it("should support multiple CTEs", async () => {
      await seed();

      const rows = await connector.query(`
        WITH
          "active_authors" AS (
            SELECT DISTINCT "authorId" FROM "posts" WHERE "authorId" IS NOT NULL
          ),
          "commented_posts" AS (
            SELECT DISTINCT "postId" FROM "comments"
          )
        SELECT a."name"
        FROM "authors" a
        WHERE a."id" IN (SELECT "authorId" FROM "active_authors")
          AND a."id" IN (
            SELECT p."authorId"
            FROM "posts" p
            WHERE p."id" IN (SELECT "postId" FROM "commented_posts")
          )
        ORDER BY a."name"
      `);

      expect(rows.length).toBe(2);
      expect(rows[0].name).toBe("Alice");
      expect(rows[1].name).toBe("Bob");
    });
  });
});
