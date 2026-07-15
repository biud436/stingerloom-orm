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

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: core cascade write paths (non-buffer)", () => {
  let conn: TestConnectionResult;
  let Parent: new () => any;
  let Child: new () => any;

  const parentName = shortName("ccparent");
  const childName = shortName("ccchild");

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
        Entity()(ChildC);
        Child = ChildC;

        OneToMany(() => ChildC, {
          mappedBy: "parent",
          cascade: true,
        })(ParentC.prototype, "children");
        Entity()(ParentC);
        Parent = ParentC;

        return { entities: [ParentC, ChildC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${parentName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT, "grp" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${childName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "label" TEXT, "parentId" INTEGER)`,
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
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

  // KNOWN DEFECT (#414): cascadeDeleteOneToMany issues the child deletes
  // through ctx.delete WITHOUT the outer delete's session, so they open a
  // NEW transaction. On SQLite's single shared connection the nested BEGIN
  // throws ("cannot start a transaction within a transaction"), so core
  // cascade delete fails entirely; on PG/MySQL the children commit in a
  // separate transaction (atomicity violation). `it.failing` keeps the repro
  // green in CI and flips to a hard failure the moment #414 fixes it —
  // remove `.failing` then.
  it.failing("em.delete(Parent, pk) cascade-deletes the single parent's children (#414)", async () => {
    const a: any = await conn.em.save(Parent, { name: "A", grp: "del" } as any);
    await conn.em.save(Child, { label: "a1", parentId: a.id } as any);

    await conn.em.delete(Parent, { id: a.id } as any);

    const children = (await conn.em.query(
      `SELECT "label" FROM "${childName}"`,
    )) as any[];
    expect(children).toHaveLength(0);
  });

  it.failing("em.delete(Parent, criteria) matching MULTIPLE parents cascade-deletes all their children via IN (#414)", async () => {
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
});
