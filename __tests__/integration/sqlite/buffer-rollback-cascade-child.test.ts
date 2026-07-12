/**
 * SQLite In-Memory: WriteBuffer flush-failure restoration of CASCADE children.
 *
 * Regression for the audited rollback gap: `capturePreFlushColumnState` only
 * snapshotted the persist-queue and tracked instances. Children that flush
 * reached through cascade (e.g. an O2M array on a persisted parent) were
 * mutated in place too — the cascade INSERT writes back their generated PK,
 * FK columns, and timestamps. When a LATER statement failed and the whole
 * transaction rolled back, the parent was restored but the children kept a PK
 * for rows that no longer exist (ghost state), so a retry mis-classified them.
 *
 * The fix extends the pre-flush snapshot to every instance reachable from the
 * persist-queue / tracked roots through loaded O2M / O2O / M2M relation values
 * (without triggering lazy proxies), and restores them all on failure.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
} from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
  OneToOneScanner,
} from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: WriteBuffer rollback restores cascade children", () => {
  let conn: TestConnectionResult;
  let Author: new () => any;
  let Post: new () => any;

  const authorName = shortName("rbcauthor");
  const postName = shortName("rbcpost");

  beforeAll(async () => {
    // SQLite cannot ALTER TABLE ADD FOREIGN KEY, so synchronize is off and
    // the tables are created by hand.
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        getScannerInstance(ColumnScanner).clear();
        getScannerInstance(ManyToOneScanner).clear();
        getScannerInstance(OneToManyScanner).clear();
        getScannerInstance(ManyToManyScanner).clear();
        getScannerInstance(OneToOneScanner).clear();

        // ── Author (O2M → Post, cascade insert) ──
        const AuthorC = class {} as any;
        Object.defineProperty(AuthorC, "name", { value: authorName });
        Reflect.defineMetadata("design:type", Number, AuthorC.prototype, "id");
        PrimaryGeneratedColumn()(AuthorC.prototype, "id");
        Reflect.defineMetadata("design:type", String, AuthorC.prototype, "name");
        Column()(AuthorC.prototype, "name");
        Reflect.defineMetadata("design:type", Array, AuthorC.prototype, "posts");

        // ── Post (M2O → Author via backing @Column authorId) ──
        const PostC = class {} as any;
        Object.defineProperty(PostC, "name", { value: postName });
        Reflect.defineMetadata("design:type", Number, PostC.prototype, "id");
        PrimaryGeneratedColumn()(PostC.prototype, "id");
        Reflect.defineMetadata("design:type", String, PostC.prototype, "title");
        Column()(PostC.prototype, "title");
        Reflect.defineMetadata("design:type", Number, PostC.prototype, "authorId");
        Column({ type: "int", nullable: true })(PostC.prototype, "authorId");
        Reflect.defineMetadata("design:type", AuthorC, PostC.prototype, "author");
        ManyToOne(
          () => AuthorC,
          (a: any) => a.posts,
        )(PostC.prototype, "author");
        Entity()(PostC);
        Post = PostC;

        OneToMany(() => PostC, {
          mappedBy: "author",
          cascade: true,
        })(AuthorC.prototype, "posts");
        Entity()(AuthorC);
        Author = AuthorC;

        return { entities: [AuthorC, PostC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${authorName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${postName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT, "authorId" INTEGER)`,
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${postName}"`);
    await connector.query(`DELETE FROM "${authorName}"`);
  });

  it("restores cascade-inserted children (PK + FK) when a later flush step fails", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const author = new Author() as any;
    author.name = "kim";
    const p1 = new Post() as any;
    p1.title = "c1";
    const p2 = new Post() as any;
    p2.title = "c2";
    author.posts = [p1, p2];

    buf.persist(author);
    // A queued DELETE runs AFTER the persists + cascades — failing there
    // proves the earlier in-memory mutations are rolled back.
    buf.delete(Post, { id: 999999 });

    let arm = true;
    buf.onFlushEvent("preDelete", () => {
      if (arm) throw new Error("boom");
    });

    await expect(buf.flush()).rejects.toThrow("boom");

    // Parent restore (already covered by the earlier fix).
    expect(author.id).toBeUndefined();
    // Cascade children must be restored too — the audited gap.
    expect(p1.id).toBeUndefined();
    expect(p2.id).toBeUndefined();
    expect(p1.authorId).toBeUndefined();
    expect(p2.authorId).toBeUndefined();

    // Nothing was committed.
    expect(await conn.em.find(Author)).toHaveLength(0);
    expect(await conn.em.find(Post)).toHaveLength(0);

    // Retry (disarmed) succeeds cleanly from the restored state.
    arm = false;
    const result = await buf.flush();
    expect(result.inserts).toBeGreaterThanOrEqual(3);

    const rows: any[] = await conn.em.find(Post);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.authorId === author.id)).toBe(true);
  });
});
