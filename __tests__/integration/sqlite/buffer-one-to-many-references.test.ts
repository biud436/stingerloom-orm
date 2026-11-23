/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WriteBuffer paths of a `@OneToMany` whose owning `@ManyToOne` references
 * a column other than the parent's primary key (SQLite :memory:).
 *
 * The buffer matched those rows by the parent's primary key: cascaded and
 * added children got the parent's id in a join column that references its
 * `code` (a foreign key violation), the lazy collection loaded `[]`, the
 * buffer's lazy ManyToOne looked the parent up by id, and a cascade delete
 * left the deleted children in the identity map.
 *
 * Every warehouse's `code` differs from its `id`.
 *
 * The eviction miss was not specific to `references`: the cascade matched
 * tracked children by the join column's name, while a hydrated child holds
 * an @RelationColumn key under `${relation}Id` — the last block pins the
 * primary-key case.
 *
 * Runs only under INTEGRATION_TEST=true (see jest.config.js).
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  ManyToOne,
  RelationColumn,
  UniqueIndex,
} from "../../../src";
import type { Relation } from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { EntityManager } from "../../../src/core/EntityManager";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

@Entity({ name: "bomr_warehouse" })
@UniqueIndex(["code"])
class Warehouse {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int", nullable: true } as any) code!: number | null;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => Shelf, { mappedBy: "warehouse", cascade: ["insert", "update", "delete"] } as any)
  shelves!: Relation<Shelf>[];
}

@Entity({ name: "bomr_shelf" })
class Shelf {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
  @ManyToOne(() => Warehouse, (w: Warehouse) => w.shelves)
  @RelationColumn({ name: "warehouse_code", type: "int", nullable: true, referencedColumn: "code" } as any)
  warehouse!: Relation<Warehouse> | null;
}

@Entity({ name: "bomr_crate" })
class Crate {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => Box, { mappedBy: "crate", cascade: ["delete"] } as any)
  boxes!: Relation<Box>[];
}

@Entity({ name: "bomr_box" })
class Box {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
  @ManyToOne(() => Crate, (c: Crate) => c.boxes)
  @RelationColumn({ name: "crate_id", type: "int", nullable: true } as any)
  crate!: Relation<Crate> | null;
}

describe("[Integration] SQLite: WriteBuffer OneToMany referencing a non-key column", () => {
  let em: EntityManager;
  let north: Warehouse;
  let south: Warehouse;

  beforeEach(async () => {
    em = new EntityManager();
    await em.register({
      type: "sqlite",
      database: ":memory:",
      entities: [Warehouse, Shelf, Crate, Box],
      synchronize: true,
      logging: false,
      plugins: [bufferPlugin()],
    } as any);
    north = await em.save(Warehouse, { code: 20, name: "north" } as any);
    south = await em.save(Warehouse, { code: 10, name: "south" } as any);
  });

  afterEach(async () => {
    await em.propagateShutdown({ closeConnections: true } as any);
  });

  const buffer = (): WriteBuffer => (em as any).buffer();
  const shelves = () =>
    em.query(`SELECT label, warehouse_code FROM bomr_shelf ORDER BY id`) as Promise<any[]>;
  const shelf = (label: string) => Object.assign(new Shelf(), { label });

  it("cascades a persisted parent's rows with its referenced value", async () => {
    const buf = buffer();
    buf.persist(
      Object.assign(new Warehouse(), { code: 30, name: "east", shelves: [shelf("x"), shelf("y")] }),
    );
    await buf.flush();
    expect(await shelves()).toEqual([
      { label: "x", warehouse_code: 30 },
      { label: "y", warehouse_code: 30 },
    ]);
  });

  it("writes a row added to a tracked parent's collection with the referenced value", async () => {
    const buf = buffer();
    const parent: any = await buf.findOne(Warehouse, { where: { id: south.id } } as any);
    parent.shelves = [...(await parent.shelves), shelf("y")];
    await buf.flush();
    expect(await shelves()).toEqual([{ label: "y", warehouse_code: 10 }]);
  });

  it("loads the lazy collection by the referenced value", async () => {
    await em.save(Shelf, { label: "s", warehouse: south } as any);
    const buf = buffer();
    const parent: any = await buf.findOne(Warehouse, { where: { id: south.id } } as any);
    expect((await parent.shelves).map((s: any) => s.label)).toEqual(["s"]);
  });

  it("loads the lazy ManyToOne by the referenced value", async () => {
    await em.save(Shelf, { label: "s", warehouse: south } as any);
    const buf = buffer();
    const row: any = await buf.findOne(Shelf, { where: { label: "s" } } as any);
    expect((await row.warehouse).name).toBe("south");
  });

  it("evicts the rows a cascade delete removes", async () => {
    const kept = await em.save(Shelf, { label: "kept", warehouse: north } as any);
    const gone = await em.save(Shelf, { label: "gone", warehouse: south } as any);
    const buf = buffer();
    await buf.findOne(Shelf, { where: { id: kept.id } } as any);
    await buf.findOne(Shelf, { where: { id: gone.id } } as any);
    const parent = await buf.findOne(Warehouse, { where: { id: south.id } } as any);

    buf.remove(parent);
    await buf.flush();

    expect(await shelves()).toEqual([{ label: "kept", warehouse_code: 20 }]);
    expect(await buf.findOne(Shelf, { where: { id: gone.id } } as any)).toBeNull();
    expect(await buf.findOne(Shelf, { where: { id: kept.id } } as any)).not.toBeNull();
  });

  it("lists the referenced value in preview()", async () => {
    const buf = buffer();
    const parent: any = await buf.findOne(Warehouse, { where: { id: south.id } } as any);
    parent.shelves = [...(await parent.shelves), shelf("y")];
    buf.persist(Object.assign(new Warehouse(), { code: 30, name: "east", shelves: [shelf("x")] }));

    const inserts = buf.preview().filter((e) => e.entity === "Shelf");
    expect(inserts.map((e: any) => e.data)).toEqual([
      expect.objectContaining({ label: "x", warehouseId: 30 }),
      expect.objectContaining({ label: "y", warehouseId: 10 }),
    ]);
  });

  it("refuses to cascade when the parent does not state the referenced value", async () => {
    const buf = buffer();
    buf.persist(Object.assign(new Warehouse(), { name: "nameless", shelves: [shelf("x")] }));
    await expect(buf.flush()).rejects.toMatchObject({ code: OrmErrorCode.INVALID_QUERY });
    expect(await shelves()).toEqual([]);
    expect(await em.find(Warehouse, { where: { name: "nameless" } } as any)).toEqual([]);
  });

  it("evicts the rows a cascade delete removes under a primary-key reference", async () => {
    const crate = await em.save(Crate, { name: "c" } as any);
    const box = await em.save(Box, { label: "b", crate } as any);
    const buf = buffer();
    await buf.findOne(Box, { where: { id: box.id } } as any);
    buf.remove(await buf.findOne(Crate, { where: { id: crate.id } } as any));
    await buf.flush();

    expect(await em.find(Box, {} as any)).toEqual([]);
    expect(await buf.findOne(Box, { where: { id: box.id } } as any)).toBeNull();
  });
});
