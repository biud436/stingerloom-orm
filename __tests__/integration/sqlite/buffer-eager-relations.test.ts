/**
 * SQLite In-Memory: WriteBuffer identity-map registration of eagerly loaded
 * relations.
 *
 * Regression for two audited defects:
 *
 *  1. Children loaded together with a parent (`relations: [...]` /
 *     `eager: true`) were NOT identity-resolved or tracked — only the root of
 *     the query result was. Editing such a child was invisible to the flush
 *     dirty-check, so the change was silently dropped.
 *
 *  2. When the loaded root hit an existing identity-map entry, the freshly
 *     loaded instance was discarded WHOLE — including relation values the
 *     caller explicitly asked for. A tracked parent whose collection was not
 *     yet materialized kept an unmaterialized state even though the data had
 *     just been fetched.
 *
 * The fix walks the loaded relation graph in resolveIdentity(): every loaded
 * M2O/O2O/O2M/M2M child is resolved through the identity map (registered +
 * tracked, with lazy proxies for its own unloaded relations), and on an
 * identity-map hit the fresh relation values are attached to the canonical
 * instance when it does not have them loaded yet.
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

describe("[Integration] SQLite: WriteBuffer eager-loaded relation tracking", () => {
  let conn: TestConnectionResult;
  let Author: new () => any;
  let Post: new () => any;

  const authorName = shortName("egauthor");
  const postName = shortName("egpost");

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

        // ── Author (O2M → Post) ──
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

        OneToMany(() => PostC, { mappedBy: "author" })(AuthorC.prototype, "posts");
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

  async function seed(): Promise<{ authorId: number; postIds: number[] }> {
    const author = await conn.em.save(Author, { name: "kim" } as any);
    const p1 = await conn.em.save(Post, { title: "one", authorId: author.id } as any);
    const p2 = await conn.em.save(Post, { title: "two", authorId: author.id } as any);
    return { authorId: author.id, postIds: [p1.id, p2.id] };
  }

  it("tracks eagerly loaded O2M children so their edits flush", async () => {
    const { authorId, postIds } = await seed();

    const buf: WriteBuffer = (conn.em as any).buffer();
    const author: any = await buf.findOne(Author, {
      where: { id: authorId } as any,
      relations: ["posts"],
    });
    expect(author).not.toBeNull();
    expect(Array.isArray(author.posts)).toBe(true);
    expect(author.posts).toHaveLength(2);

    // The children must be identity-registered — a later PK lookup returns the
    // very same instance.
    const first = author.posts.find((p: any) => p.id === postIds[0]);
    const same = await buf.findOne(Post, { where: { id: postIds[0] } as any });
    expect(same).toBe(first);

    // The child is tracked — editing it flushes an UPDATE.
    first.title = "edited";
    const result = await buf.flush();
    expect(result.updates).toBe(1);

    const reloaded: any = await conn.em.findOne(Post, {
      where: { id: postIds[0] } as any,
    });
    expect(reloaded.title).toBe("edited");
  });

  it("attaches freshly loaded relations to the canonical instance on an identity-map hit", async () => {
    const { authorId, postIds } = await seed();

    const buf: WriteBuffer = (conn.em as any).buffer();
    // First load WITHOUT relations — the instance is tracked, `posts` is not
    // materialized (lazy proxy).
    const a1: any = await buf.findOne(Author, { where: { id: authorId } as any });
    expect(a1).not.toBeNull();

    // Second load WITH relations hits the identity map. The freshly fetched
    // children must be attached to the canonical instance, not thrown away.
    const a2: any = await buf.findOne(Author, {
      where: { id: authorId } as any,
      relations: ["posts"],
    });
    expect(a2).toBe(a1);

    const desc = Object.getOwnPropertyDescriptor(a1, "posts");
    expect(desc !== undefined && "value" in desc).toBe(true);
    expect(Array.isArray(a1.posts)).toBe(true);
    expect(a1.posts).toHaveLength(2);

    // The attached children are tracked — editing one flushes.
    const second = a1.posts.find((p: any) => p.id === postIds[1]);
    second.title = "attached-edit";
    const result = await buf.flush();
    expect(result.updates).toBe(1);

    const reloaded: any = await conn.em.findOne(Post, {
      where: { id: postIds[1] } as any,
    });
    expect(reloaded.title).toBe("attached-edit");
  });

  it("tracks an eagerly loaded M2O parent so its edits flush", async () => {
    const { authorId, postIds } = await seed();

    const buf: WriteBuffer = (conn.em as any).buffer();
    const post: any = await buf.findOne(Post, {
      where: { id: postIds[0] } as any,
      relations: ["author"],
    });
    expect(post).not.toBeNull();
    expect(post.author).toBeDefined();
    expect(post.author.name).toBe("kim");

    // Identity: a direct author lookup returns the very same instance.
    const sameAuthor = await buf.findOne(Author, { where: { id: authorId } as any });
    expect(sameAuthor).toBe(post.author);

    post.author.name = "renamed";
    const result = await buf.flush();
    expect(result.updates).toBe(1);

    const reloaded: any = await conn.em.findOne(Author, {
      where: { id: authorId } as any,
    });
    expect(reloaded.name).toBe("renamed");
  });
});
