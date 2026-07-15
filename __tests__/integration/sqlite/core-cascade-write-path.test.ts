/**
 * SQLite In-Memory: core (non-buffer) cascade write paths (issue #404).
 *
 * Backfills __tests__/unit/cascade-handler.test.ts, which mocks
 * ctx.save/ctx.delete and asserts only call counts / criteria shapes:
 *
 *  1. cascadeSaveManyToOne — em.save(Child, { parent: {...} }) with cascade
 *     insert must INSERT the parent row and write the child's FK column.
 *     The unit test proves `ctx.save` was called and `childItem.parentId`
 *     was set IN MEMORY; whether either value reaches a real table was
 *     verified nowhere outside the WriteBuffer plugin path.
 *  2. cascadeDeleteOneToMany, multi-parent IN branch — deleting several
 *     parents in one call must delete the children of ALL of them (single
 *     `WHERE fk IN (...)`), and only those. The unit test asserts the mocked
 *     criteria object `{ parentId: [10, 20] }` and nothing else.
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
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
  OneToOneScanner,
} from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";
import type { EntitySubscriber } from "../../../src/core/EntitySubscriber";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: core cascade write paths (non-buffer)", () => {
  let conn: TestConnectionResult;
  let Parent: new () => any;
  let Child: new () => any;
  let Grand: new () => any;

  const parentName = shortName("ccparent");
  const childName = shortName("ccchild");
  const grandName = shortName("ccgrand");

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
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
        Reflect.defineMetadata("design:type", String, ParentC.prototype, "grp");
        Column()(ParentC.prototype, "grp");
        Reflect.defineMetadata("design:type", Array, ParentC.prototype, "children");

        const ChildC = class {} as any;
        Object.defineProperty(ChildC, "name", { value: childName });
        Reflect.defineMetadata("design:type", Number, ChildC.prototype, "id");
        PrimaryGeneratedColumn()(ChildC.prototype, "id");
        Reflect.defineMetadata("design:type", String, ChildC.prototype, "label");
        Column()(ChildC.prototype, "label");
        // FK via the `${prop}Id` backing-column convention.
        Reflect.defineMetadata("design:type", Number, ChildC.prototype, "parentId");
        Column({ nullable: true })(ChildC.prototype, "parentId");
        Reflect.defineMetadata("design:type", ParentC, ChildC.prototype, "parent");
        ManyToOne(
          () => ParentC,
          (p: any) => p.children,
          { cascade: ["insert"] },
        )(ChildC.prototype, "parent");

        // Grandchild — one level below Child, same `${prop}Id` FK convention.
        // Exercises the recursive branch: the cascade delete of Child rows
        // re-enters WriteExecutor.delete, which must reuse the SAME session.
        const GrandC = class {} as any;
        Object.defineProperty(GrandC, "name", { value: grandName });
        Reflect.defineMetadata("design:type", Number, GrandC.prototype, "id");
        PrimaryGeneratedColumn()(GrandC.prototype, "id");
        Reflect.defineMetadata("design:type", String, GrandC.prototype, "tag");
        Column()(GrandC.prototype, "tag");
        Reflect.defineMetadata("design:type", Number, GrandC.prototype, "childId");
        Column({ nullable: true })(GrandC.prototype, "childId");
        Reflect.defineMetadata("design:type", ChildC, GrandC.prototype, "child");
        ManyToOne(() => ChildC, (c: any) => c.grandchildren)(
          GrandC.prototype,
          "child",
        );
        Entity()(GrandC);
        Grand = GrandC;

        Reflect.defineMetadata("design:type", Array, ChildC.prototype, "grandchildren");
        OneToMany(() => GrandC, {
          mappedBy: "child",
          cascade: true,
        })(ChildC.prototype, "grandchildren");
        Entity()(ChildC);
        Child = ChildC;

        OneToMany(() => ChildC, {
          mappedBy: "parent",
          cascade: true,
        })(ParentC.prototype, "children");
        Entity()(ParentC);
        Parent = ParentC;

        return { entities: [ParentC, ChildC, GrandC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${parentName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT, "grp" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${childName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "label" TEXT, "parentId" INTEGER)`,
    );
    // UNIQUE on label gives the save-path atomicity test a way to make the
    // batch INSERT fail after the cascade parents were already saved.
    await connector.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_${childName}_label" ON "${childName}" ("label")`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${grandName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "tag" TEXT, "childId" INTEGER)`,
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${grandName}"`);
    await connector.query(`DELETE FROM "${childName}"`);
    await connector.query(`DELETE FROM "${parentName}"`);
  });

  it("em.save(Child, { parent: {...} }) INSERTs the parent row and writes the child FK", async () => {
    const savedChild: any = await conn.em.save(Child, {
      label: "c1",
      parent: { name: "new-parent", grp: "g" },
    } as any);

    // The parent row must exist in the database.
    const parents = (await conn.em.query(
      `SELECT "id", "name" FROM "${parentName}"`,
    )) as any[];
    expect(parents).toHaveLength(1);
    expect(parents[0].name).toBe("new-parent");

    // The child's FK COLUMN (not just the in-memory property) must point at it.
    const children = (await conn.em.query(
      `SELECT "label", "parentId" FROM "${childName}"`,
    )) as any[];
    expect(children).toHaveLength(1);
    expect(children[0].label).toBe("c1");
    expect(children[0].parentId).toBe(parents[0].id);
    expect(savedChild.parentId).toBe(parents[0].id);
  });

  // #414: cascadeDeleteOneToMany used to issue the child deletes through
  // ctx.delete WITHOUT the outer delete's session, opening a NEW transaction
  // (nested-BEGIN crash on SQLite's single shared connection; separate-commit
  // atomicity violation on PG/MySQL). Fixed by publishing the outer session
  // via transactionStorage.run() in WriteExecutor.delete().
  it("em.delete(Parent, pk) cascade-deletes the single parent's children (#414)", async () => {
    const a: any = await conn.em.save(Parent, { name: "A", grp: "del" } as any);
    await conn.em.save(Child, { label: "a1", parentId: a.id } as any);

    await conn.em.delete(Parent, { id: a.id } as any);

    const children = (await conn.em.query(
      `SELECT "label" FROM "${childName}"`,
    )) as any[];
    expect(children).toHaveLength(0);
  });

  it("em.delete(Parent, criteria) matching MULTIPLE parents cascade-deletes all their children via IN (#414)", async () => {
    const a: any = await conn.em.save(Parent, { name: "A", grp: "del" } as any);
    const b: any = await conn.em.save(Parent, { name: "B", grp: "del" } as any);
    const keep: any = await conn.em.save(Parent, { name: "C", grp: "keep" } as any);
    await conn.em.save(Child, { label: "a1", parentId: a.id } as any);
    await conn.em.save(Child, { label: "a2", parentId: a.id } as any);
    await conn.em.save(Child, { label: "b1", parentId: b.id } as any);
    await conn.em.save(Child, { label: "k1", parentId: keep.id } as any);

    await conn.em.delete(Parent, { grp: "del" } as any);

    const parents = (await conn.em.query(
      `SELECT "name" FROM "${parentName}"`,
    )) as any[];
    expect(parents.map((p) => p.name)).toEqual(["C"]);

    // Children of BOTH deleted parents are gone; the survivor's child remains.
    const children = (await conn.em.query(
      `SELECT "label", "parentId" FROM "${childName}"`,
    )) as any[];
    expect(children).toHaveLength(1);
    expect(children[0].label).toBe("k1");
    expect(children[0].parentId).toBe(keep.id);
  });

  it("cascade delete recurses to grandchildren inside the same transaction (#414)", async () => {
    const a: any = await conn.em.save(Parent, { name: "A", grp: "del" } as any);
    const c: any = await conn.em.save(Child, { label: "c-rec", parentId: a.id } as any);
    await conn.em.save(Grand, { tag: "g1", childId: c.id } as any);
    await conn.em.save(Grand, { tag: "g2", childId: c.id } as any);

    await conn.em.delete(Parent, { id: a.id } as any);

    const children = (await conn.em.query(
      `SELECT "id" FROM "${childName}"`,
    )) as any[];
    const grands = (await conn.em.query(
      `SELECT "id" FROM "${grandName}"`,
    )) as any[];
    expect(children).toHaveLength(0);
    expect(grands).toHaveLength(0);
  });

  it("cascade delete is atomic — a throwing afterDelete subscriber restores the children (#414)", async () => {
    const a: any = await conn.em.save(Parent, { name: "A", grp: "del" } as any);
    await conn.em.save(Child, { label: "atomic-1", parentId: a.id } as any);

    // afterDelete fires inside the delete's transaction, after the children
    // and the parent row were already deleted — throwing here must roll BOTH
    // back. Pre-#414 the child delete had committed in its own transaction,
    // so the child stayed lost while the parent survived.
    const failing: EntitySubscriber<any> = {
      listenTo: () => Parent as any,
      afterDelete: async () => {
        throw new Error("afterDelete boom");
      },
    };
    conn.em.addSubscriber(failing);
    try {
      await expect(
        conn.em.delete(Parent, { id: a.id } as any),
      ).rejects.toThrow("afterDelete boom");
    } finally {
      conn.em.removeSubscriber(failing);
    }

    const parents = (await conn.em.query(
      `SELECT "id" FROM "${parentName}"`,
    )) as any[];
    const children = (await conn.em.query(
      `SELECT "label" FROM "${childName}"`,
    )) as any[];
    expect(parents).toHaveLength(1);
    expect(children).toHaveLength(1);
    expect(children[0].label).toBe("atomic-1");
  });

  it("saveMany fallback (explicit PKs) with cascade M2O parents joins the outer transaction (#414)", async () => {
    const c1: any = await conn.em.save(Child, { label: "m1" } as any);
    const c2: any = await conn.em.save(Child, { label: "m2" } as any);

    // Explicit PKs disable the batch-INSERT path, so each item goes through
    // saveInternal(entity, item, session) under saveMany's transaction (the
    // UPDATE branch here). The cascade parent saves must reuse that session —
    // pre-#414 they opened a second one, and the nested BEGIN on SQLite's
    // single connection crashed the whole saveMany.
    await conn.em.saveMany(Child, [
      { id: c1.id, label: "m1", parent: { name: "MP1", grp: "g" } },
      { id: c2.id, label: "m2", parent: { name: "MP2", grp: "g" } },
    ] as any[]);

    const parents = (await conn.em.query(
      `SELECT "id", "name" FROM "${parentName}" ORDER BY "id"`,
    )) as any[];
    expect(parents.map((p) => p.name)).toEqual(["MP1", "MP2"]);

    // The cascade must also have linked each child to its new parent.
    const children = (await conn.em.query(
      `SELECT "id", "label", "parentId" FROM "${childName}" ORDER BY "id"`,
    )) as any[];
    expect(children).toHaveLength(2);
    expect(children[0].parentId).toBe(parents[0].id);
    expect(children[1].parentId).toBe(parents[1].id);
  });

  it("saveMany batch INSERT failure rolls back the cascade-saved M2O parents (#414)", async () => {
    // Generated PKs → batch-INSERT path. The duplicate label violates the
    // unique index, failing the batch INSERT after both cascade parents were
    // saved. Atomicity requires the parents to roll back with it — pre-#414
    // they were committed before the transaction even opened.
    // try/catch instead of `.rejects.toThrow()`: the SqliteError originates in
    // the shared native binding, and jest's instanceof-based matcher proved
    // order-dependent across test-file realms in the full-suite run.
    let threw: unknown = false;
    try {
      await conn.em.saveMany(Child, [
        { label: "dup", parent: { name: "RB1", grp: "g" } },
        { label: "dup", parent: { name: "RB2", grp: "g" } },
      ] as any[]);
    } catch (e) {
      threw = e ?? true;
    }
    expect(String(threw)).toContain("UNIQUE");

    const parents = (await conn.em.query(
      `SELECT "id" FROM "${parentName}"`,
    )) as any[];
    const children = (await conn.em.query(
      `SELECT "id" FROM "${childName}"`,
    )) as any[];
    expect(parents).toHaveLength(0);
    expect(children).toHaveLength(0);
  });
});
