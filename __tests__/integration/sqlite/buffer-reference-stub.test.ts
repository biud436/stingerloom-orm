/**
 * SQLite In-Memory: WriteBuffer getReference() stub semantics.
 *
 * Regression for two audited defects in the PK-only reference stub:
 *
 *  1. Values written to a stub were silently lost on flush. The stub was
 *     registered in the identity map but never snapshot-tracked, so the flush
 *     dirty-check skipped it entirely — `ref.title = "x"; flush()` was a no-op.
 *     The fix snapshot-tracks the stub with a PK-only baseline: exactly the
 *     columns the caller writes diff as dirty and flush issues a targeted
 *     UPDATE. Hydration (via findOne) re-baselines against the DB row while
 *     preserving still-dirty user writes.
 *
 *  2. @ManyToOne / owning-side @OneToOne proxies were never injected on a stub.
 *     Proxy injection required the FK value, which a PK-only stub does not have
 *     — the relation property stayed plain `undefined`. The fix injects a
 *     hydrate-first proxy: on first access the stub's own row is loaded (which
 *     hydrates the stub in place), then the FK chains into the normal relation
 *     load.
 *
 *  3. A stub for a nonexistent row failed silently everywhere: hydration
 *     quietly no-opped, and writes flushed as a 0-row UPDATE that reported
 *     success (no @Version → no affected-rows check) — the write was lost
 *     without a trace. The fix makes both paths explicit: hydration throws
 *     EntityNotFoundError, and flushing a dirty still-unhydrated stub first
 *     verifies the row exists (one SELECT that also hydrates the stub).
 *     Unloaded scalar reads stay `undefined` by contract (a reference is
 *     PK-only until hydrated) — pinned by test below.
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
  OneToOne,
  EntityNotFoundError,
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

function countQueriesOn(
  spy: jest.SpyInstance,
  verb: "SELECT" | "UPDATE",
  table: string,
): number {
  const re =
    verb === "UPDATE"
      ? new RegExp(`^\\s*UPDATE\\s+"?${table}"?`, "i")
      : new RegExp(`^\\s*SELECT\\b[\\s\\S]*\\bFROM\\s+"?${table}"?`, "i");
  return spy.mock.calls.filter((c) => re.test(sqlOf(c))).length;
}

describe("[Integration] SQLite: WriteBuffer getReference() stub", () => {
  let conn: TestConnectionResult;
  let Item: new () => any;
  let Author: new () => any;
  let Post: new () => any;
  let Profile: new () => any;
  let Usr: new () => any;

  const itemName = shortName("refitem");
  const authorName = shortName("refauthor");
  const postName = shortName("refpost");
  const profileName = shortName("refprofile");
  const usrName = shortName("refusr");

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

        // ── Item (plain, for scalar-write tests) ──
        const ItemC = class {} as any;
        Object.defineProperty(ItemC, "name", { value: itemName });
        Reflect.defineMetadata("design:type", Number, ItemC.prototype, "id");
        PrimaryGeneratedColumn()(ItemC.prototype, "id");
        Reflect.defineMetadata("design:type", String, ItemC.prototype, "title");
        Column()(ItemC.prototype, "title");
        Reflect.defineMetadata("design:type", String, ItemC.prototype, "note");
        Column()(ItemC.prototype, "note");
        Entity()(ItemC);
        Item = ItemC;

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

        // ── Profile / Usr (owning O2O via profile_id) ──
        const ProfileC = class {} as any;
        Object.defineProperty(ProfileC, "name", { value: profileName });
        Reflect.defineMetadata("design:type", Number, ProfileC.prototype, "id");
        PrimaryGeneratedColumn()(ProfileC.prototype, "id");
        Reflect.defineMetadata("design:type", String, ProfileC.prototype, "bio");
        Column()(ProfileC.prototype, "bio");
        Entity()(ProfileC);
        Profile = ProfileC;

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
        })(UsrC.prototype, "profile");
        Entity()(UsrC);
        Usr = UsrC;

        return { entities: [ItemC, AuthorC, PostC, ProfileC, UsrC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${itemName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT, "note" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${authorName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${postName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT, "authorId" INTEGER)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${profileName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "bio" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${usrName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT, "profile_id" INTEGER)`,
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${postName}"`);
    await connector.query(`DELETE FROM "${authorName}"`);
    await connector.query(`DELETE FROM "${itemName}"`);
    await connector.query(`DELETE FROM "${usrName}"`);
    await connector.query(`DELETE FROM "${profileName}"`);
  });

  it("flushes values written to a stub as a targeted UPDATE", async () => {
    const seeded: any = await conn.em.save(Item, {
      title: "original",
      note: "keep",
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const ref: any = buf.getReference(Item, seeded.id);
    ref.title = "patched";

    await buf.flush();

    const reloaded: any = await conn.em.findOne(Item, {
      where: { id: seeded.id } as any,
    });
    expect(reloaded.title).toBe("patched");
    // Columns the caller never touched stay intact.
    expect(reloaded.note).toBe("keep");
  });

  it("flushes nothing for an untouched stub", async () => {
    const seeded: any = await conn.em.save(Item, {
      title: "original",
      note: "keep",
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    buf.getReference(Item, seeded.id);

    const result = await buf.flush();
    expect(result).toEqual({ updates: 0, inserts: 0, deletes: 0 });

    const reloaded: any = await conn.em.findOne(Item, {
      where: { id: seeded.id } as any,
    });
    expect(reloaded.title).toBe("original");
  });

  it("keeps a pre-hydration stub write dirty through findOne hydration", async () => {
    const seeded: any = await conn.em.save(Item, {
      title: "original",
      note: "keep",
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const ref: any = buf.getReference(Item, seeded.id);
    ref.title = "patched";

    // Hydration must fill the untouched columns from the DB but NOT clobber
    // the pending user write.
    const loaded: any = await buf.findOne(Item, { where: { id: seeded.id } as any });
    expect(loaded).toBe(ref);
    expect(ref.note).toBe("keep");
    expect(ref.title).toBe("patched");

    const result = await buf.flush();
    expect(result.updates).toBe(1);

    const reloaded: any = await conn.em.findOne(Item, {
      where: { id: seeded.id } as any,
    });
    expect(reloaded.title).toBe("patched");
    expect(reloaded.note).toBe("keep");
  });

  it("injects a working @ManyToOne proxy on a PK-only stub", async () => {
    const author: any = await conn.em.save(Author, { name: "kim" } as any);
    const post: any = await conn.em.save(Post, {
      title: "hello",
      authorId: author.id,
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const ref: any = buf.getReference(Post, post.id);

    // Audited bug: the M2O property was plain undefined (no proxy injected,
    // because the PK-only stub carries no FK value).
    const loadedAuthor: any = await ref.author;
    expect(loadedAuthor).toBeDefined();
    expect(loadedAuthor.name).toBe("kim");

    // The loaded relation is identity-registered.
    const sameAuthor = await buf.findOne(Author, { where: { id: author.id } as any });
    expect(sameAuthor).toBe(loadedAuthor);
  });

  it("injects a working owning-side @OneToOne proxy on a PK-only stub", async () => {
    const profile: any = await conn.em.save(Profile, { bio: "hi" } as any);
    const usr: any = await conn.em.save(Usr, {
      name: "lee",
      profile_id: profile.id,
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const ref: any = buf.getReference(Usr, usr.id);

    const loadedProfile: any = await ref.profile;
    expect(loadedProfile).toBeDefined();
    expect(loadedProfile.bio).toBe("hi");
  });

  // ── Nonexistent-row references fail explicitly, never silently ──

  it("rejects a flush that writes to a stub for a nonexistent row", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();
    const ref: any = buf.getReference(Item, 999999);
    ref.title = "ghost";
    // A queued insert in the same flush must not survive the abort.
    buf.save(Item, { title: "queued", note: "n" });

    // Audited bug: this flushed as a 0-row UPDATE that reported success —
    // the write vanished without an error (no @Version → no affected check).
    await expect(buf.flush()).rejects.toThrow(EntityNotFoundError);

    const connector = DatabaseClient.getInstance().getConnection();
    const rows: any = await connector.query(
      `SELECT COUNT(*) AS cnt FROM "${itemName}"`,
    );
    expect(Number(rows[0]?.cnt ?? rows?.cnt)).toBe(0);
  });

  it("rejects FK-relation access on a stub for a nonexistent row", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();
    const ref: any = buf.getReference(Post, 424242);

    // Audited bug: the hydration miss was silent — the relation resolved as
    // if the row existed with no FK, indistinguishable from a NULL FK.
    await expect(ref.author).rejects.toThrow(EntityNotFoundError);
  });

  it("verifies and hydrates a dirty stub before its UPDATE (one SELECT, one UPDATE)", async () => {
    const seeded: any = await conn.em.save(Item, {
      title: "original",
      note: "keep",
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const ref: any = buf.getReference(Item, seeded.id);
    ref.title = "patched";

    const connector = DatabaseClient.getInstance().getConnection();
    const spy = jest.spyOn(connector, "query");
    try {
      await buf.flush();
      // Exactly one UPDATE, preceded by exactly one SELECT — the existence
      // verification. (save() may re-read the row AFTER its UPDATE to return
      // fresh values; only pre-UPDATE SELECTs are the verification's.)
      expect(countQueriesOn(spy, "UPDATE", itemName)).toBe(1);
      const updateRe = new RegExp(`^\\s*UPDATE\\s+"?${itemName}"?`, "i");
      const firstUpdate = spy.mock.calls.findIndex((c) => updateRe.test(sqlOf(c)));
      const selectRe = new RegExp(`^\\s*SELECT\\b[\\s\\S]*\\bFROM\\s+"?${itemName}"?`, "i");
      const selectsBeforeUpdate = spy.mock.calls
        .slice(0, firstUpdate)
        .filter((c) => selectRe.test(sqlOf(c))).length;
      expect(selectsBeforeUpdate).toBe(1);
    } finally {
      spy.mockRestore();
    }

    // The existence check doubles as hydration: untouched columns are now
    // populated on the reference itself.
    expect(ref.note).toBe("keep");
    expect(ref.title).toBe("patched");

    const reloaded: any = await conn.em.findOne(Item, {
      where: { id: seeded.id } as any,
    });
    expect(reloaded.title).toBe("patched");
    expect(reloaded.note).toBe("keep");
  });

  it("issues no existence check for a clean stub", async () => {
    const seeded: any = await conn.em.save(Item, {
      title: "original",
      note: "keep",
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    buf.getReference(Item, seeded.id);

    const connector = DatabaseClient.getInstance().getConnection();
    const spy = jest.spyOn(connector, "query");
    try {
      await buf.flush();
      expect(countQueriesOn(spy, "SELECT", itemName)).toBe(0);
      expect(countQueriesOn(spy, "UPDATE", itemName)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves unloaded scalars undefined until hydration (PK-only contract)", async () => {
    const seeded: any = await conn.em.save(Item, {
      title: "original",
      note: "keep",
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const ref: any = buf.getReference(Item, seeded.id);

    // Documented contract: a reference is PK-only until hydrated. Scalar
    // reads never trigger a hidden load.
    expect(ref.id).toBe(seeded.id);
    expect(ref.title).toBeUndefined();
    expect(ref.note).toBeUndefined();

    await buf.findOne(Item, { where: { id: seeded.id } as any });
    expect(ref.title).toBe("original");
    expect(ref.note).toBe("keep");
  });
});
