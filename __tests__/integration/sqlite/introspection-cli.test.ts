/**
 * Introspection CLI integration test (SQLite, in-memory).
 *
 * Builds a small schema in :memory:, runs `runIntrospect` against it, and
 * asserts that the generated entity files contain the expected decorators
 * for PKs, columns, FK relations, indexes, and timestamps.
 *
 * Uses better-sqlite3 directly so no external DB server is required.
 */

import "reflect-metadata";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { runIntrospect } from "../../../src/introspection/IntrospectionCli";

describe("[Integration] Introspection CLI (SQLite file-backed)", () => {
  let tempDir: string;
  let dbFile: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "stg-introspect-"));
    dbFile = join(tempDir, "introspect-test.sqlite");
    // Seed the schema once, into a file-backed SQLite db so subsequent
    // runIntrospect connections see the same data.
    const client = DatabaseClient.getInstance();
    const connector = await client.connect({
      type: "sqlite",
      database: dbFile,
      logging: false,
    } as any);
    await connector.query(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL, created_at DATETIME NOT NULL)",
    );
    await connector.query("CREATE UNIQUE INDEX uq_users_email ON users(email)");
    await connector.query(
      "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL, FOREIGN KEY(author_id) REFERENCES users(id))",
    );
    await client.close();
  });

  afterAll(async () => {
    await DatabaseClient.getInstance().close().catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await DatabaseClient.getInstance().close().catch(() => {});
  });

  it("writes one entity file per table with the expected decorators", async () => {
    const outputDir = resolve(tempDir, "entities");
    const result = await runIntrospect(
      { type: "sqlite", database: dbFile, logging: false } as any,
      { outputDir },
    );

    expect(result.writtenFiles.length).toBe(2);
    const tableNames = result.entities.map((e) => e.tableName).sort();
    expect(tableNames).toEqual(["posts", "users"]);

    const usersFile = result.writtenFiles.find((p) => p.endsWith("user.entity.ts"))!;
    const usersCode = await readFile(usersFile, "utf8");
    expect(usersCode).toContain("@Entity(");
    expect(usersCode).toContain("@PrimaryGeneratedColumn()");
    expect(usersCode).toContain('@Column({ type: "varchar", length: 255 })');
    expect(usersCode).toContain("@CreateTimestamp()");
    expect(usersCode).toContain('@UniqueIndex(["email"], "uq_users_email")');

    const postsFile = result.writtenFiles.find((p) => p.endsWith("post.entity.ts"))!;
    const postsCode = await readFile(postsFile, "utf8");
    expect(postsCode).toContain("@ManyToOne(() => User, (entity: any) => entity.author)");
    expect(postsCode).toContain('@RelationColumn({ name: "author_id" })');
  });

  it("supports --dry-run (returns entities without writing files)", async () => {
    const outputDir = resolve(tempDir, "dry-entities");
    const result = await runIntrospect(
      { type: "sqlite", database: dbFile, logging: false } as any,
      { outputDir, dryRun: true },
    );

    expect(result.writtenFiles).toEqual([]);
    expect(result.entities.length).toBe(2);
  });

  it("honors includeTables filter", async () => {
    const result = await runIntrospect(
      { type: "sqlite", database: dbFile, logging: false } as any,
      { outputDir: resolve(tempDir, "include-entities"), includeTables: ["users"] },
    );

    expect(result.entities.map((e) => e.tableName)).toEqual(["users"]);
  });
});
