/**
 * SQLite In-Memory: WriteBuffer cascade write amplification.
 *
 * Audited defect group (2026-07 UoW audit, V2-T0-1): flushing a dirty tracked
 * parent re-saves EVERY loaded cascade child regardless of dirtiness.
 *
 *  1. Unchanged tracked children are re-UPDATEd (1 parent edit → 1+N writes),
 *     firing spurious core lifecycle events and @UpdateTimestamp bumps.
 *  2. A child that is tracked+dirty AND cascade-reachable is written TWICE —
 *     once by the parent's cascade, once by the dirty-tracked flush pass
 *     (the pass never consults `visited` and cascade never re-baselines).
 *  3. Flush stats count every cascade save as an INSERT (`result.inserts++`)
 *     even when the save was an UPDATE of an existing row.
 *  4. Cascade recursion always passes `isNewParent=true`, so a tracked child
 *     with a materialized M2M collection gets its pivot rows re-INSERTed on
 *     every parent flush — a PK conflict on SQLite/PG, silent duplication
 *     without a pivot PK.
 *  5. O2O owning-side cascade re-saves a clean related entity and always runs
 *     the FK fix-up UPDATE on the parent row even when the FK is unchanged.
 *
 * SQLite does not support ALTER TABLE ADD FOREIGN KEY and does not auto-create
 * M2M pivot tables, so synchronize is off and tables are created by hand.
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
  ManyToMany,
  OneToOne,
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

/** Extract the SQL text of a connector.query() spy call (string or Sql tag). */
function sqlOf(call: unknown[]): string {
  const a = call[0] as any;
  if (typeof a === "string") return a;
  return a?.sql ?? a?.text ?? String(a);
}

function countUpdatesOn(spy: jest.SpyInstance, table: string): number {
  const re = new RegExp(`^\\s*UPDATE\\s+"?${table}"?`, "i");
  return spy.mock.calls.filter((c) => re.test(sqlOf(c))).length;
}

describe("[Integration] SQLite: WriteBuffer cascade write amplification", () => {
  let conn: TestConnectionResult;
  let Author: new () => any;
  let Post: new () => any;
  let Tag: new () => any;
  let Usr: new () => any;
  let Profile: new () => any;

  const authorName = shortName("ampauthor");
  const postName = shortName("amppost");
  const tagName = shortName("amptag");
  const pivotName = shortName("amppivot");
  const usrName = shortName("ampusr");
  const profileName = shortName("ampprofile");

  beforeAll(async () => {
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

        // ── Tag ──
        const TagC = class {} as any;
        Object.defineProperty(TagC, "name", { value: tagName });
        Reflect.defineMetadata("design:type", Number, TagC.prototype, "id");
        PrimaryGeneratedColumn()(TagC.prototype, "id");
        Reflect.defineMetadata("design:type", String, TagC.prototype, "label");
        Column()(TagC.prototype, "label");
        Entity()(TagC);
        Tag = TagC;

        // ── Author (O2M → Post, cascade) ──
        const AuthorC = class {} as any;
        Object.defineProperty(AuthorC, "name", { value: authorName });
        Reflect.defineMetadata("design:type", Number, AuthorC.prototype, "id");
        PrimaryGeneratedColumn()(AuthorC.prototype, "id");
        Reflect.defineMetadata("design:type", String, AuthorC.prototype, "name");
        Column()(AuthorC.prototype, "name");
        Reflect.defineMetadata("design:type", Array, AuthorC.prototype, "posts");

        // ── Post (M2O → Author via backing @Column authorId, owning M2M → Tag) ──
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
        Reflect.defineMetadata("design:type", Array, PostC.prototype, "tags");
        ManyToMany(() => TagC, {
          joinTable: {
            name: pivotName,
            joinColumn: "post_id",
            inverseJoinColumn: "tag_id",
          },
        })(PostC.prototype, "tags");
        Entity()(PostC);
        Post = PostC;

        OneToMany(() => PostC, { mappedBy: "author", cascade: true })(
          AuthorC.prototype,
          "posts",
        );
        Entity()(AuthorC);
        Author = AuthorC;

        // ── Profile ──
        const ProfileC = class {} as any;
        Object.defineProperty(ProfileC, "name", { value: profileName });
        Reflect.defineMetadata("design:type", Number, ProfileC.prototype, "id");
        PrimaryGeneratedColumn()(ProfileC.prototype, "id");
        Reflect.defineMetadata("design:type", String, ProfileC.prototype, "bio");
        Column()(ProfileC.prototype, "bio");
        Entity()(ProfileC);
        Profile = ProfileC;

        // ── Usr (owning O2O → Profile via profile_id, cascade) ──
        const UsrC = class {} as any;
        Object.defineProperty(UsrC, "name", { value: usrName });
        Reflect.defineMetadata("design:type", Number, UsrC.prototype, "id");
        PrimaryGeneratedColumn()(UsrC.prototype, "id");
        Reflect.defineMetadata("design:type", String, UsrC.prototype, "name");
        Column()(UsrC.prototype, "name");
        Reflect.defineMetadata("design:type", Number, UsrC.prototype, "profile_id");
        Column({ type: "int", nullable: true })(UsrC.prototype, "profile_id");
        Reflect.defineMetadata("design:type", ProfileC, UsrC.prototype, "profile");
        OneToOne(() => ProfileC, {
          joinColumn: "profile_id",
          cascade: true,
        })(UsrC.prototype, "profile");
        Entity()(UsrC);
        Usr = UsrC;

        return { entities: [TagC, AuthorC, PostC, ProfileC, UsrC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${authorName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${postName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT, "authorId" INTEGER)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${tagName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "label" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${pivotName}" ("post_id" INTEGER NOT NULL, "tag_id" INTEGER NOT NULL, PRIMARY KEY ("post_id", "tag_id"))`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${usrName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT, "profile_id" INTEGER)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${profileName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "bio" TEXT)`,
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${pivotName}"`);
    await connector.query(`DELETE FROM "${postName}"`);
    await connector.query(`DELETE FROM "${tagName}"`);
    await connector.query(`DELETE FROM "${authorName}"`);
    await connector.query(`DELETE FROM "${usrName}"`);
    await connector.query(`DELETE FROM "${profileName}"`);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function seedAuthorWithPosts(): Promise<{
    authorId: number;
    postIds: number[];
  }> {
    const author = await conn.em.save(Author, { name: "kim" } as any);
    const p1 = await conn.em.save(Post, {
      title: "one",
      authorId: author.id,
    } as any);
    const p2 = await conn.em.save(Post, {
      title: "two",
      authorId: author.id,
    } as any);
    return { authorId: author.id, postIds: [p1.id, p2.id] };
  }

  it("does not re-save unchanged loaded children when only the parent changed", async () => {
    const { authorId } = await seedAuthorWithPosts();

    const buf: WriteBuffer = (conn.em as any).buffer();
    const author: any = await buf.findOne(Author, {
      where: { id: authorId } as any,
      relations: ["posts"],
    });
    expect(author.posts).toHaveLength(2);

    author.name = "lee";

    const connector = DatabaseClient.getInstance().getConnection();
    const spy = jest.spyOn(connector, "query");
    const result = await buf.flush();

    expect(countUpdatesOn(spy, authorName)).toBe(1);
    expect(countUpdatesOn(spy, postName)).toBe(0);
    expect(result).toEqual({ updates: 1, inserts: 0, deletes: 0 });
  });

  it("writes a tracked+dirty cascade child exactly once, with one event pair", async () => {
    const { authorId } = await seedAuthorWithPosts();

    const buf: WriteBuffer = (conn.em as any).buffer();
    const author: any = await buf.findOne(Author, {
      where: { id: authorId } as any,
      relations: ["posts"],
    });

    author.name = "lee";
    author.posts[0].title = "one-edited";
    const editedId = author.posts[0].id;

    const preUpdates: string[] = [];
    const postUpdates: string[] = [];
    buf.onFlushEvent("preUpdate", (e) => {
      preUpdates.push(e.entity.name);
    });
    buf.onFlushEvent("postUpdate", (e) => {
      postUpdates.push(e.entity.name);
    });

    const connector = DatabaseClient.getInstance().getConnection();
    const spy = jest.spyOn(connector, "query");
    const result = await buf.flush();

    expect(countUpdatesOn(spy, authorName)).toBe(1);
    // The regression: the dirty child was UPDATEd by the parent's cascade AND
    // again by the dirty-tracked pass (plus the clean sibling once) → 3.
    expect(countUpdatesOn(spy, postName)).toBe(1);
    expect(result).toEqual({ updates: 2, inserts: 0, deletes: 0 });

    expect(preUpdates.filter((n) => n === postName)).toHaveLength(1);
    expect(postUpdates.filter((n) => n === postName)).toHaveLength(1);

    const rows: any[] = await conn.em.query(
      `SELECT title FROM "${postName}" WHERE id = ?`,
      [editedId],
    );
    expect(rows[0].title).toBe("one-edited");
  });

  it("still counts cascade INSERTs of new children as inserts (persist path)", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const author = new Author();
    (author as any).name = "park";
    const p1 = new Post();
    (p1 as any).title = "fresh-1";
    const p2 = new Post();
    (p2 as any).title = "fresh-2";
    (author as any).posts = [p1, p2];

    buf.persist(author);
    const result = await buf.flush();

    expect(result).toEqual({ updates: 0, inserts: 3, deletes: 0 });
    const rows: any[] = await conn.em.query(
      `SELECT "authorId" FROM "${postName}" ORDER BY id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.authorId === (author as any).id)).toBe(true);
  });

  it("does not re-insert a tracked child's M2M pivot rows on parent flush", async () => {
    const { authorId, postIds } = await seedAuthorWithPosts();
    const tag = await conn.em.save(Tag, { label: "red" } as any);
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `INSERT INTO "${pivotName}" ("post_id", "tag_id") VALUES (${postIds[0]}, ${(tag as any).id})`,
    );

    const buf: WriteBuffer = (conn.em as any).buffer();
    const author: any = await buf.findOne(Author, {
      where: { id: authorId } as any,
      relations: ["posts"],
    });
    // Materialize post.tags on the tracked (canonical) instance via an
    // identity-map hit, so the cascade recursion can see the collection.
    const post: any = await buf.findOne(Post, {
      where: { id: postIds[0] } as any,
      relations: ["tags"],
    });
    expect(post.tags).toHaveLength(1);
    expect(author.posts.some((p: any) => p === post)).toBe(true);

    author.name = "lee";

    // The regression: cascade recursion into the (unchanged) tracked child ran
    // with isNewParent=true, re-INSERTing its pivot rows — a PK conflict here.
    const result = await buf.flush();
    expect(result.updates).toBe(1);

    const rows: any[] = await conn.em.query(
      `SELECT * FROM "${pivotName}" WHERE post_id = ?`,
      [postIds[0]],
    );
    expect(rows).toHaveLength(1);
  });

  it("does not re-save a clean O2O related entity nor repeat the FK fix-up UPDATE", async () => {
    const profile = await conn.em.save(Profile, { bio: "hi" } as any);
    const usr = await conn.em.save(Usr, {
      name: "alice",
      profile_id: (profile as any).id,
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const loaded: any = await buf.findOne(Usr, {
      where: { id: (usr as any).id } as any,
      relations: ["profile"],
    });
    expect(loaded.profile).toBeDefined();

    loaded.name = "alice2";

    const connector = DatabaseClient.getInstance().getConnection();
    const spy = jest.spyOn(connector, "query");
    const result = await buf.flush();

    // The regression: 2 UPDATEs on usr (save + unconditional FK fix-up) and
    // 1 spurious UPDATE on the unchanged profile.
    expect(countUpdatesOn(spy, usrName)).toBe(1);
    expect(countUpdatesOn(spy, profileName)).toBe(0);
    expect(result).toEqual({ updates: 1, inserts: 0, deletes: 0 });
  });
});
