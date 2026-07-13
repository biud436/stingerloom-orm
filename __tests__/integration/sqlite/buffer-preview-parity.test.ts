/**
 * SQLite In-Memory: preview() parity with flush() (issue #402 item 3).
 *
 * Audited divergences, each shown against real flush behavior:
 *
 *  1. preview() listed updates for read-only entries and — under
 *     ChangeTrackingPolicy.DEFERRED_EXPLICIT — for entries never marked
 *     dirty, which flush() skips.
 *  2. preview() knew nothing about collection diffs: O2M cascade writes of
 *     added children, orphan removals (including the reparent sparing),
 *     and M2M pivot INSERT/DELETEs were all missing.
 *  3. preview() did not list the cascade-persist children of persist-queue
 *     instances, which flush() saves right after the parent.
 *
 * preview() must also be a PURE read: it must not assign FKs onto child
 * instances or trigger anything — flush observes the same state either way.
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
  RelationColumn,
} from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import {
  ChangeTrackingPolicy,
  type BufferPreviewEntry,
} from "../../../src/core/plugin/buffer/BufferPreview";
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

describe("[Integration] SQLite: WriteBuffer preview() parity with flush()", () => {
  let conn: TestConnectionResult;
  let Parent: new () => any;
  let Child: new () => any;
  let Post: new () => any;
  let Tag: new () => any;

  const parentName = shortName("pvparent");
  const childName = shortName("pvchild");
  const postName = shortName("pvpost");
  const tagName = shortName("pvtag");
  const pivotName = shortName("pvpivot");

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

        const ParentC = class {} as any;
        Object.defineProperty(ParentC, "name", { value: parentName });
        Reflect.defineMetadata("design:type", Number, ParentC.prototype, "id");
        PrimaryGeneratedColumn()(ParentC.prototype, "id");
        Reflect.defineMetadata("design:type", String, ParentC.prototype, "name");
        Column()(ParentC.prototype, "name");
        Reflect.defineMetadata("design:type", Array, ParentC.prototype, "children");

        const ChildC = class {} as any;
        Object.defineProperty(ChildC, "name", { value: childName });
        Reflect.defineMetadata("design:type", Number, ChildC.prototype, "id");
        PrimaryGeneratedColumn()(ChildC.prototype, "id");
        Reflect.defineMetadata("design:type", String, ChildC.prototype, "label");
        Column()(ChildC.prototype, "label");
        Reflect.defineMetadata("design:type", ParentC, ChildC.prototype, "parent");
        ManyToOne(
          () => ParentC,
          (p: any) => p.children,
        )(ChildC.prototype, "parent");
        RelationColumn({ name: "parent_id" })(ChildC.prototype, "parent");
        Entity()(ChildC);
        Child = ChildC;

        OneToMany(() => ChildC, {
          mappedBy: "parent",
          cascade: true,
        })(ParentC.prototype, "children");
        Entity()(ParentC);
        Parent = ParentC;

        const TagC = class {} as any;
        Object.defineProperty(TagC, "name", { value: tagName });
        Reflect.defineMetadata("design:type", Number, TagC.prototype, "id");
        PrimaryGeneratedColumn()(TagC.prototype, "id");
        Reflect.defineMetadata("design:type", String, TagC.prototype, "label");
        Column()(TagC.prototype, "label");
        Entity()(TagC);
        Tag = TagC;

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

        return { entities: [ParentC, ChildC, PostC, TagC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${parentName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${childName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "label" TEXT, "parent_id" INTEGER)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${postName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${tagName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "label" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${pivotName}" ("post_id" INTEGER, "tag_id" INTEGER)`,
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    for (const t of [pivotName, childName, parentName, postName, tagName]) {
      await connector.query(`DELETE FROM "${t}"`);
    }
  });

  function ofAction(entries: BufferPreviewEntry[], action: string): any[] {
    return entries.filter((e) => e.action === action);
  }

  it("excludes read-only entries, exactly as flush() does", async () => {
    const seeded: any = await conn.em.save(Parent, { name: "ro" } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const loaded: any = await buf.findOne(Parent, { where: { id: seeded.id } as any });
    loaded.name = "ro-changed";
    buf.markReadOnly(loaded);

    // Regression: preview() listed the update flush() would skip.
    expect(ofAction(buf.preview(), "update")).toHaveLength(0);
    const result = await buf.flush();
    expect(result.updates).toBe(0);
  });

  it("respects ChangeTrackingPolicy.DEFERRED_EXPLICIT, exactly as flush() does", async () => {
    const seeded: any = await conn.em.save(Parent, { name: "ex" } as any);

    const buf: WriteBuffer = (conn.em as any).buffer({
      changeTracking: ChangeTrackingPolicy.DEFERRED_EXPLICIT,
    });
    const loaded: any = await buf.findOne(Parent, { where: { id: seeded.id } as any });
    loaded.name = "ex-changed";

    // Not marked dirty → flush() skips it, so preview() must too.
    expect(ofAction(buf.preview(), "update")).toHaveLength(0);

    buf.markDirty(loaded);
    const updates = ofAction(buf.preview(), "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].data.name).toBe("ex-changed");
  });

  it("lists the O2M cascade INSERT of an added child — without mutating the child", async () => {
    const a: any = await conn.em.save(Parent, { name: "A" } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const parentA = new Parent() as any;
    parentA.id = a.id;
    parentA.name = "A";
    parentA.children = [];
    buf.track(parentA);

    const c2 = new Child() as any;
    c2.label = "c2";
    parentA.children.push(c2);

    const entries = buf.preview();
    const inserts = ofAction(entries, "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].entity).toBe(childName);
    expect(inserts[0].data.label).toBe("c2");
    // The tracked parent's PK is known, so the FK rides along in the data.
    expect(Object.values(inserts[0].data)).toContain(a.id);

    // preview() is a pure read: the child instance itself carries no FK yet.
    expect(Object.getOwnPropertyNames(c2)).toEqual(["label"]);
    // And it is idempotent.
    expect(buf.preview()).toEqual(entries);

    // Parity: flush really inserts that child with the FK.
    await buf.flush();
    const rows = (await conn.em.query(
      `SELECT "label", "parent_id" FROM "${childName}"`,
    )) as any[];
    expect(rows).toEqual([{ label: "c2", parent_id: a.id }]);
  });

  it("lists orphan-removal DELETEs but spares reparented children, exactly as flush() does", async () => {
    const a: any = await conn.em.save(Parent, { name: "A" } as any);
    const b: any = await conn.em.save(Parent, { name: "B" } as any);
    const c1: any = await conn.em.save(Child, { label: "c1", parentId: a.id } as any);

    const buf: WriteBuffer = (conn.em as any).buffer({ orphanRemoval: true });
    const parentA = new Parent() as any;
    parentA.id = a.id;
    parentA.name = "A";
    parentA.children = [c1];
    buf.track(parentA);
    const parentB = new Parent() as any;
    parentB.id = b.id;
    parentB.name = "B";
    parentB.children = [];
    buf.track(parentB);

    // Reparent: c1 moves A → B. flush() spares it from orphan removal, so
    // preview() must not list a DELETE for it either.
    parentA.children = [];
    parentB.children = [c1];
    const reparentPreview = buf.preview();
    expect(ofAction(reparentPreview, "delete")).toHaveLength(0);
    // The added-with-PK child is re-saved by flush (em.save → UPDATE).
    const updates = ofAction(reparentPreview, "update").filter(
      (e) => e.entity === childName,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({ id: c1.id });

    // True orphan: removed from A, added nowhere → DELETE is listed.
    parentB.children = [];
    const orphanPreview = buf.preview();
    const deletes = ofAction(orphanPreview, "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].entity).toBe(childName);
    expect(deletes[0].criteria).toEqual({ id: c1.id });

    // Parity: flush actually deletes the orphan.
    await buf.flush();
    const rows = (await conn.em.query(`SELECT "id" FROM "${childName}"`)) as any[];
    expect(rows).toHaveLength(0);
  });

  it("lists M2M pivot INSERT/DELETE for collection diffs on a tracked parent", async () => {
    const p: any = await conn.em.save(Post, { title: "p" } as any);
    const t1: any = await conn.em.save(Tag, { label: "t1" } as any);
    const t2: any = await conn.em.save(Tag, { label: "t2" } as any);
    await conn.em.query(
      `INSERT INTO "${pivotName}" ("post_id", "tag_id") VALUES (?, ?)`,
      [p.id, t1.id],
    );

    const buf: WriteBuffer = (conn.em as any).buffer();
    const post = new Post() as any;
    post.id = p.id;
    post.title = "p";
    post.tags = [t1];
    buf.track(post);

    // Swap t1 → t2: one pivot INSERT and one pivot DELETE.
    post.tags = [t2];
    const entries = buf.preview();
    const pivotInserts = ofAction(entries, "insert").filter((e) => e.entity === pivotName);
    const pivotDeletes = ofAction(entries, "delete").filter((e) => e.entity === pivotName);
    expect(pivotInserts).toHaveLength(1);
    expect(pivotInserts[0].data).toEqual({ post_id: p.id, tag_id: t2.id });
    expect(pivotDeletes).toHaveLength(1);
    expect(pivotDeletes[0].criteria).toEqual({ post_id: p.id, tag_id: t1.id });

    // Parity: flush syncs the pivot exactly like that.
    await buf.flush();
    const rows = (await conn.em.query(
      `SELECT "post_id", "tag_id" FROM "${pivotName}"`,
    )) as any[];
    expect(rows).toEqual([{ post_id: p.id, tag_id: t2.id }]);
  });

  it("lists cascade-persist children (and M2M pivot rows) of persist-queue instances", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    // New parent + new child through O2M cascade.
    const parent = new Parent() as any;
    parent.name = "NP";
    const child = new Child() as any;
    child.label = "nc";
    parent.children = [child];
    buf.persist(parent);

    // New post + new tag through M2M cascade (owning side).
    const post = new Post() as any;
    post.title = "np";
    const tag = new Tag() as any;
    tag.label = "nt";
    post.tags = [tag];
    buf.persist(post);

    const entries = buf.preview();
    const inserts = ofAction(entries, "insert");
    const byEntity = (name: string) => inserts.filter((e) => e.entity === name);

    expect(byEntity(parentName)).toHaveLength(1);
    // Regression: the cascade child never appeared in preview().
    expect(byEntity(childName)).toHaveLength(1);
    expect(byEntity(childName)[0].data.label).toBe("nc");
    expect(byEntity(postName)).toHaveLength(1);
    expect(byEntity(tagName)).toHaveLength(1);
    // One pivot row will be written for the new post's tag (values are
    // DB-generated PKs, unknown before flush — the operation is still listed).
    expect(byEntity(pivotName)).toHaveLength(1);

    // The parent insert precedes its cascade child insert, matching flush order.
    const order = inserts.map((e) => e.entity);
    expect(order.indexOf(parentName)).toBeLessThan(order.indexOf(childName));

    // Parity: flush writes all of it.
    await buf.flush();
    const childRows = (await conn.em.query(
      `SELECT "label", "parent_id" FROM "${childName}"`,
    )) as any[];
    expect(childRows).toEqual([{ label: "nc", parent_id: parent.id }]);
    const pivotRows = (await conn.em.query(
      `SELECT "post_id", "tag_id" FROM "${pivotName}"`,
    )) as any[];
    expect(pivotRows).toEqual([{ post_id: post.id, tag_id: tag.id }]);
  });
});
