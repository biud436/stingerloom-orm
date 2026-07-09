/**
 * SQLite In-Memory: WriteBuffer cascade-persist data loss regressions.
 *
 * Three audited data-loss defects, each reproduced against real SQL:
 *
 *  1. M2M cascade persist of a NEW parent drops the pivot rows.
 *     A newly persist()ed parent lands in the persist queue, not the tracked
 *     set, so the collection-diff step (which writes pivot rows) never runs for
 *     it. The child rows exist, but the join table stays empty — the M2M link
 *     is silently lost.
 *
 *  2. O2O owning-side cascade persist leaves the parent FK NULL.
 *     The parent row is INSERTed before the cascaded related entity is saved,
 *     so the FK is written only in memory (instance[joinColumn]) and never
 *     reaches the already-inserted parent row.
 *
 *  3. merge() of a detached instance never UPDATEs.
 *     merge() of an instance the buffer has never seen falls through to
 *     track(), which snapshots the instance's CURRENT values — so the diff is
 *     empty and the detached edits are dropped on flush.
 *
 * SQLite does not support ALTER TABLE ADD FOREIGN KEY / ADD CONSTRAINT and does
 * not auto-create M2M pivot tables, so we use synchronize:false and create
 * every table (incl. the pivot) by hand.
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

describe("[Integration] SQLite: WriteBuffer cascade-persist data loss", () => {
  let conn: TestConnectionResult;
  let Post: new () => any;
  let Tag: new () => any;
  let Usr: new () => any;
  let Profile: new () => any;
  let Widget: new () => any;

  // All-lowercase single tokens: the default SnakeNamingStrategy would rewrite
  // a camelCase class name (cpPost → cp_post), so the entity's resolved table
  // name would not match the table we CREATE by hand below.
  const postName = shortName("cppost");
  const tagName = shortName("cptag");
  const pivotName = shortName("cppivot");
  const usrName = shortName("cpusr");
  const profileName = shortName("cpprofile");
  const widgetName = shortName("cpwidget");

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

        // ── Post (owning M2M → Tag) ──
        const PostC = class {} as any;
        Object.defineProperty(PostC, "name", { value: postName });
        Reflect.defineMetadata("design:type", Number, PostC.prototype, "id");
        PrimaryGeneratedColumn()(PostC.prototype, "id");
        Reflect.defineMetadata("design:type", String, PostC.prototype, "title");
        Column()(PostC.prototype, "title");
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

        // ── Profile ──
        const ProfileC = class {} as any;
        Object.defineProperty(ProfileC, "name", { value: profileName });
        Reflect.defineMetadata("design:type", Number, ProfileC.prototype, "id");
        PrimaryGeneratedColumn()(ProfileC.prototype, "id");
        Reflect.defineMetadata("design:type", String, ProfileC.prototype, "bio");
        Column()(ProfileC.prototype, "bio");
        Entity()(ProfileC);
        Profile = ProfileC;

        // ── Usr (owning O2O → Profile via profile_id, cascade insert) ──
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

        // ── Widget (plain, for merge) ──
        const WidgetC = class {} as any;
        Object.defineProperty(WidgetC, "name", { value: widgetName });
        Reflect.defineMetadata("design:type", Number, WidgetC.prototype, "id");
        PrimaryGeneratedColumn()(WidgetC.prototype, "id");
        Reflect.defineMetadata("design:type", String, WidgetC.prototype, "name");
        Column()(WidgetC.prototype, "name");
        Reflect.defineMetadata("design:type", String, WidgetC.prototype, "color");
        Column()(WidgetC.prototype, "color");
        Entity()(WidgetC);
        Widget = WidgetC;

        return { entities: [TagC, PostC, ProfileC, UsrC, WidgetC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${tagName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "label" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${postName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${pivotName}" ("post_id" INTEGER NOT NULL, "tag_id" INTEGER NOT NULL, PRIMARY KEY ("post_id", "tag_id"))`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${profileName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "bio" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${usrName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT, "profile_id" INTEGER)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${widgetName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT, "color" TEXT)`,
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
    await connector.query(`DELETE FROM "${usrName}"`);
    await connector.query(`DELETE FROM "${profileName}"`);
    await connector.query(`DELETE FROM "${widgetName}"`);
  });

  it("writes M2M pivot rows when a NEW parent is persisted with existing children", async () => {
    const t1 = await conn.em.save(Tag, { label: "red" } as any);
    const t2 = await conn.em.save(Tag, { label: "blue" } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const post = new Post();
    (post as any).title = "hello";
    (post as any).tags = [t1, t2];
    buf.persist(post);
    await buf.flush();

    expect((post as any).id).toBeDefined();
    const rows: any[] = await conn.em.query(
      `SELECT * FROM "${pivotName}" WHERE post_id = ?`,
      [(post as any).id],
    );
    expect(rows).toHaveLength(2);
    const tagIds = rows.map((r) => r.tag_id).sort();
    expect(tagIds).toEqual([(t1 as any).id, (t2 as any).id].sort());
  });

  it("persists the owning-side FK to the DB on O2O cascade insert", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();
    const user = new Usr();
    (user as any).name = "alice";
    const profile = new Profile();
    (profile as any).bio = "hi";
    (user as any).profile = profile;

    buf.persist(user);
    await buf.flush();

    expect((profile as any).id).toBeDefined();
    expect((user as any).profile_id).toBe((profile as any).id);

    const rows: any[] = await conn.em.query(
      `SELECT profile_id FROM "${usrName}" WHERE id = ?`,
      [(user as any).id],
    );
    expect(rows).toHaveLength(1);
    // The regression: profile_id stayed NULL in the DB even though it was set
    // on the in-memory instance.
    expect(rows[0].profile_id).toBe((profile as any).id);
  });

  it("UPDATEs a detached instance's changed columns on merge()", async () => {
    const seeded = await conn.em.save(Widget, {
      name: "a",
      color: "red",
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const detached = new Widget();
    (detached as any).id = (seeded as any).id;
    (detached as any).name = "b";
    (detached as any).color = "red";

    buf.merge(detached);
    const result = await buf.flush();
    expect(result.updates).toBe(1);

    const reloaded: any = await conn.em.findOne(Widget, {
      where: { id: (seeded as any).id } as any,
    });
    expect(reloaded).not.toBeNull();
    expect(reloaded.name).toBe("b");
    expect(reloaded.color).toBe("red");
  });
});
