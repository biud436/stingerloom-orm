/**
 * SQLite In-Memory: lazy relation proxies must be enumeration-safe.
 *
 * Lazy relation getters used to be `enumerable: true` and fired their load on
 * ANY first read — so JSON.stringify / spread / pretty-printers issued one
 * hidden query per unloaded relation and left a raw Promise whose failure
 * became an unhandled rejection. Internal write paths (cascade traversal,
 * detach propagation, collection snapshots) read the properties raw and fired
 * them too, mid-flush.
 *
 * New contract:
 * - Unloaded lazy properties are non-enumerable: serialization skips them,
 *   fires no query, creates no promise. Loading/setting promotes the property
 *   to a plain enumerable value, so loaded relations serialize normally.
 * - flush()/detach() never fire an unloaded lazy relation.
 * - Direct property access still lazy-loads; a failed load rejects the
 *   awaiting caller but never crashes the process when the promise is
 *   discarded.
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

describe("[Integration] SQLite: lazy relation proxy enumeration safety", () => {
  let conn: TestConnectionResult;
  let Parent: new () => any;
  let Child: new () => any;

  const parentName = shortName("leparent");
  const childName = shortName("lechild");

  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => rejections.push(reason);

  beforeAll(async () => {
    process.on("unhandledRejection", onUnhandled);

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
    process.off("unhandledRejection", onUnhandled);
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    rejections.length = 0;
    jest.restoreAllMocks();
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${childName}"`);
    await connector.query(`DELETE FROM "${parentName}"`);
  });

  async function seedParentWithChildren(): Promise<any> {
    const parent = await conn.em.save(Parent, { name: "p1" } as any);
    await conn.em.save(Child, {
      title: "c1",
      parentfk: (parent as any).id,
    } as any);
    await conn.em.save(Child, {
      title: "c2",
      parentfk: (parent as any).id,
    } as any);
    return parent;
  }

  it("JSON.stringify fires zero queries and omits unloaded lazy relations", async () => {
    const parent = await seedParentWithChildren();

    const buf: WriteBuffer = (conn.em as any).buffer();
    const p: any = await buf.findOne(Parent, {
      where: { id: (parent as any).id } as any,
    });
    const c: any = await buf.findOne(Child, {
      where: { title: "c1" } as any,
    });
    expect(p).not.toBeNull();
    expect(c).not.toBeNull();

    const findSpy = jest.spyOn(conn.em, "find");
    const findOneSpy = jest.spyOn(conn.em, "findOne");
    const querySpy = jest.spyOn(conn.em, "query");

    // Unloaded O2M collection on the parent, unloaded M2O on the child —
    // serialization must not fire either.
    const parentJson = JSON.parse(JSON.stringify(p));
    const childJson = JSON.parse(JSON.stringify(c));
    const spread = { ...p };

    expect(findSpy).not.toHaveBeenCalled();
    expect(findOneSpy).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();

    expect(parentJson).not.toHaveProperty("children");
    expect(parentJson.name).toBe("p1");
    expect(childJson).not.toHaveProperty("parent");
    expect(childJson.title).toBe("c1");
    expect(spread).not.toHaveProperty("children");

    // No dangling promise may have been created anywhere
    await new Promise((r) => setTimeout(r, 20));
    expect(rejections).toHaveLength(0);
  });

  it("a loaded collection serializes normally after materialization", async () => {
    const parent = await seedParentWithChildren();

    const buf: WriteBuffer = (conn.em as any).buffer();
    const p: any = await buf.findOne(Parent, {
      where: { id: (parent as any).id } as any,
    });

    const children = await p.children; // direct access still lazy-loads
    expect(children).toHaveLength(2);

    const json = JSON.parse(JSON.stringify(p));
    expect(json.children).toHaveLength(2);
    expect(json.children.map((ch: any) => ch.title).sort()).toEqual(["c1", "c2"]);
  });

  it("flushing a dirty parent does not load its unloaded child collection", async () => {
    const parent = await seedParentWithChildren();

    const buf: WriteBuffer = (conn.em as any).buffer();
    const p: any = await buf.findOne(Parent, {
      where: { id: (parent as any).id } as any,
    });

    p.name = "renamed";

    const findSpy = jest.spyOn(conn.em, "find");
    const result = await buf.flush();
    expect(result.updates).toBe(1);

    // The O2M relation has cascade:["insert"] — the cascade pass walks it, but
    // an unloaded lazy collection must be skipped, not fired.
    const childLoads = findSpy.mock.calls.filter(([cls]) => cls === Child);
    expect(childLoads).toHaveLength(0);

    const rows: any[] = await conn.em.query(
      `SELECT * FROM "${parentName}" WHERE id = ?`,
      [(parent as any).id],
    );
    expect(rows[0].name).toBe("renamed");

    await new Promise((r) => setTimeout(r, 20));
    expect(rejections).toHaveLength(0);
  });

  it("detach does not fire unloaded lazy relations", async () => {
    const parent = await seedParentWithChildren();

    const buf: WriteBuffer = (conn.em as any).buffer();
    const p: any = await buf.findOne(Parent, {
      where: { id: (parent as any).id } as any,
    });

    const findSpy = jest.spyOn(conn.em, "find");
    const findOneSpy = jest.spyOn(conn.em, "findOne");

    buf.detach(p); // cascade.detach walks relations — loaded ones only

    expect(findSpy).not.toHaveBeenCalled();
    expect(findOneSpy).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 20));
    expect(rejections).toHaveLength(0);
  });

  it("a failed lazy load rejects awaiting callers but never crashes on discarded access", async () => {
    const parent = await seedParentWithChildren();

    const buf: WriteBuffer = (conn.em as any).buffer();
    const p: any = await buf.findOne(Parent, {
      where: { id: (parent as any).id } as any,
    });

    // Force every load of the child collection to fail
    const findSpy = jest
      .spyOn(conn.em, "find")
      .mockRejectedValue(new Error("child load failed"));

    // Discarded sync access — fires the load, nobody awaits it
    void p.children;
    await new Promise((r) => setTimeout(r, 20));
    expect(rejections).toHaveLength(0);

    // An awaiting caller still observes the failure explicitly
    await expect(p.children).rejects.toThrow("child load failed");

    // After the failure the property is still lazy — a later access retries
    findSpy.mockRestore();
    const children = await p.children;
    expect(children).toHaveLength(2);
  });
});
