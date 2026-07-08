/**
 * SQLite In-Memory: WriteBuffer orphanRemoval must not delete a REPARENTED child.
 *
 * Audited data-loss defect: with orphanRemoval enabled, moving a child from
 * parent A to parent B makes the child appear in A's collection diff as
 * `removed`. The flush orphan-removal step DELETEs every removed child, so the
 * reparented child is destroyed even though it was merely handed to another
 * parent (it appears in B's diff as `added`). A child that still belongs to a
 * tracked parent is not an orphan and must survive.
 *
 * SQLite does not support ALTER TABLE ADD CONSTRAINT, so synchronize:false and
 * every table is created by hand.
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
  RelationColumn,
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

describe("[Integration] SQLite: WriteBuffer orphanRemoval reparenting", () => {
  let conn: TestConnectionResult;
  let Parent: new () => any;
  let Child: new () => any;

  const parentName = shortName("orphanp");
  const childName = shortName("orphanc");

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
        plugins: [bufferPlugin({ orphanRemoval: true })],
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

        return { entities: [ParentC, ChildC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${parentName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${childName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "label" TEXT, "parent_id" INTEGER)`,
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

  it("keeps a child moved from parent A to parent B (reparent, not orphan)", async () => {
    // Seed: parent A with child c1, parent B empty.
    const a: any = await conn.em.save(Parent, { name: "A" } as any);
    const b: any = await conn.em.save(Parent, { name: "B" } as any);
    const c1: any = await conn.em.save(Child, {
      label: "c1",
      parentId: a.id,
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();

    // Track both parents WITH their current collection state as the baseline.
    const parentA = new Parent();
    parentA.id = a.id;
    parentA.name = "A";
    parentA.children = [c1];
    buf.track(parentA);

    const parentB = new Parent();
    parentB.id = b.id;
    parentB.name = "B";
    parentB.children = [];
    buf.track(parentB);

    // Reparent: move c1 from A to B (same instance).
    parentA.children = [];
    parentB.children = [c1];

    await buf.flush();

    // c1 must still exist, now pointing at B — not orphan-deleted.
    const rows: any[] = await conn.em.query(
      `SELECT id, parent_id FROM "${childName}" WHERE id = ?`,
      [c1.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].parent_id).toBe(b.id);
  });

  it("still orphan-deletes a child removed from its only parent", async () => {
    const a: any = await conn.em.save(Parent, { name: "A" } as any);
    const c1: any = await conn.em.save(Child, {
      label: "c1",
      parentId: a.id,
    } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const parentA = new Parent();
    parentA.id = a.id;
    parentA.name = "A";
    parentA.children = [c1];
    buf.track(parentA);

    // Remove c1 from A, not added anywhere → genuine orphan.
    parentA.children = [];

    await buf.flush();

    const rows: any[] = await conn.em.query(
      `SELECT COUNT(*) AS c FROM "${childName}" WHERE id = ?`,
      [c1.id],
    );
    expect(Number(rows[0].c)).toBe(0);
  });
});
