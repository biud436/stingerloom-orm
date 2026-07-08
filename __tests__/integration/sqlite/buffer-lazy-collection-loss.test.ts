/**
 * SQLite In-Memory: WriteBuffer lazy-collection change loss regression.
 *
 * When a tracked entity is loaded through the buffer, its @OneToMany /
 * @ManyToMany collections are injected as lazy proxies — they are NOT arrays
 * until first accessed. track() snapshots collections eagerly, so an unloaded
 * (proxy) collection gets no snapshot baseline. If the caller then awaits the
 * collection and mutates it, the flush collection-diff step finds no snapshot
 * for that property and silently skips it — the added/removed children are
 * dropped.
 *
 * The fix captures the collection's baseline the moment its lazy proxy
 * materializes (with the freshly loaded items), so a later mutation diffs
 * correctly.
 *
 * synchronize:false + hand-created tables (SQLite has no ALTER ADD FK).
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
} from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: WriteBuffer lazy-collection change loss", () => {
  let conn: TestConnectionResult;
  let Parent: new () => any;
  let Child: new () => any;

  const parentName = shortName("lcparent");
  const childName = shortName("lcchild");

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

        const PC = class {} as any;
        Object.defineProperty(PC, "name", { value: parentName });
        Reflect.defineMetadata("design:type", Number, PC.prototype, "id");
        PrimaryGeneratedColumn()(PC.prototype, "id");
        Reflect.defineMetadata("design:type", String, PC.prototype, "name");
        Column()(PC.prototype, "name");
        Reflect.defineMetadata("design:type", Array, PC.prototype, "children");
        OneToMany(() => CC, { mappedBy: "parent", cascade: ["insert"] })(
          PC.prototype,
          "children",
        );
        Entity()(PC);

        const CC = class {} as any;
        Object.defineProperty(CC, "name", { value: childName });
        Reflect.defineMetadata("design:type", Number, CC.prototype, "id");
        PrimaryGeneratedColumn()(CC.prototype, "id");
        Reflect.defineMetadata("design:type", String, CC.prototype, "title");
        Column()(CC.prototype, "title");
        Reflect.defineMetadata("design:type", Number, CC.prototype, "parentfk");
        Column({ type: "int", nullable: true })(CC.prototype, "parentfk");
        Reflect.defineMetadata("design:type", PC, CC.prototype, "parent");
        ManyToOne(() => PC, (e: any) => e.parent, {
          joinColumn: "parentfk",
        })(CC.prototype, "parent");
        Entity()(CC);

        Parent = PC;
        Child = CC;
        return { entities: [PC, CC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${parentName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${childName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT, "parentfk" INTEGER)`,
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

  it("cascade-inserts a child pushed onto a lazily-loaded O2M collection", async () => {
    const parent = await conn.em.save(Parent, { name: "p1" } as any);
    await conn.em.save(Child, { title: "c1", parentfk: (parent as any).id } as any);
    await conn.em.save(Child, { title: "c2", parentfk: (parent as any).id } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const p: any = await buf.findOne(Parent, {
      where: { id: (parent as any).id } as any,
    });
    expect(p).not.toBeNull();

    // Materialize the lazy collection — this must capture the baseline {c1, c2}.
    const children = await p.children;
    expect(children).toHaveLength(2);

    // Mutate the now-loaded collection.
    const newChild = new Child();
    (newChild as any).title = "c3";
    p.children.push(newChild);

    const result = await buf.flush();
    expect(result.inserts).toBe(1);

    const rows: any[] = await conn.em.query(
      `SELECT * FROM "${childName}" WHERE parentfk = ?`,
      [(parent as any).id],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.title).sort()).toEqual(["c1", "c2", "c3"]);
  });
});
