/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A `@ManyToOne` whose join column references a column other than the
 * target's primary key (`references` / `@RelationColumn({ referencedColumn })`)
 * is written, loaded, counted and cascaded through that column — the one the
 * foreign key constraint points at (SQLite :memory:).
 *
 * Every warehouse's `code` differs from its `id`, so matching by the primary
 * key would attach the wrong row or none.
 *
 * Runs only under INTEGRATION_TEST=true (see jest.config.js).
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { UniqueIndex } from "../../../src/decorators/UniqueIndex";
import { Relation } from "../../../src/types/Relation";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { OrmError } from "../../../src/errors/OrmError";

@Entity({ name: "mref_warehouses" })
@UniqueIndex(["code"])
class Warehouse {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) code!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;

  @OneToMany(() => Shelf, { mappedBy: "warehouse", cascade: ["insert", "update", "delete"] })
  shelves!: Relation<Shelf>[];

  @OneToMany(() => Crate, { mappedBy: "warehouse" })
  crates!: Relation<Crate>[];
}

@Entity({ name: "mref_shelves" })
class Shelf {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;

  @ManyToOne(() => Warehouse, (w: any) => w.shelves, { references: "code", cascade: ["insert"] })
  @RelationColumn({ name: "warehouse_code", type: "int", nullable: true })
  warehouse!: Relation<Warehouse> | null;
}

@Entity({ name: "mref_crates" })
class Crate {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;

  @ManyToOne(() => Warehouse, (w: any) => w.crates, { lazy: true })
  @RelationColumn({ name: "warehouse_code", type: "int", nullable: true, referencedColumn: "code" })
  warehouse!: Relation<Warehouse> | null;
}

const ENTITIES = [Warehouse, Shelf, Crate];

describe("[Integration] SQLite: @ManyToOne referencing a non-key column", () => {
  let em: EntityManager;
  let north: Warehouse;
  let south: Warehouse;

  const shelfRows = () =>
    em.query(`SELECT label, warehouse_code FROM mref_shelves ORDER BY id`) as Promise<any[]>;

  beforeEach(async () => {
    MetadataContext.reset();
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: ENTITIES,
        synchronize: true,
        logging: false,
      } as any,
      `mref_${Math.random().toString(36).slice(2, 10)}`,
    );
    // ids 1 and 2, codes 20 and 10: no code equals an id, and code 10's id
    // is not the smaller one.
    north = await em.save(Warehouse, { code: 20, name: "north" } as any);
    south = await em.save(Warehouse, { code: 10, name: "south" } as any);
  });

  afterEach(async () => {
    await em.propagateShutdown({ closeConnections: true } as any);
  });

  describe("writes", () => {
    it("insert writes the referenced column of a related instance", async () => {
      await em.save(Shelf, { label: "a", warehouse: north } as any);
      expect(await shelfRows()).toEqual([{ label: "a", warehouse_code: 20 }]);
    });

    it("update writes the referenced column, and null clears it", async () => {
      const shelf = await em.save(Shelf, { label: "a", warehouse: north } as any);
      await em.save(Shelf, { id: shelf.id, warehouse: south } as any);
      expect(await shelfRows()).toEqual([{ label: "a", warehouse_code: 10 }]);

      await em.save(Shelf, { id: shelf.id, warehouse: null } as any);
      expect(await shelfRows()).toEqual([{ label: "a", warehouse_code: null }]);
    });

    it("a bare value is the referenced value itself", async () => {
      await em.save(Shelf, { label: "a", warehouse: 10 } as any);
      expect(await shelfRows()).toEqual([{ label: "a", warehouse_code: 10 }]);
    });

    it("multi-row inserts write the referenced column", async () => {
      await em.insertMany(Shelf, [
        { label: "a", warehouse: north },
        { label: "b", warehouse: south },
      ] as any);
      expect(await shelfRows()).toEqual([
        { label: "a", warehouse_code: 20 },
        { label: "b", warehouse_code: 10 },
      ]);
    });

    it("declares the key through @RelationColumn({ referencedColumn }) too", async () => {
      await em.save(Crate, { label: "c", warehouse: north } as any);
      const rows = (await em.query(`SELECT warehouse_code FROM mref_crates`)) as any[];
      expect(rows).toEqual([{ warehouse_code: 20 }]);
    });
  });

  describe("reads", () => {
    beforeEach(async () => {
      await em.save(Shelf, { label: "a", warehouse: north } as any);
      await em.save(Shelf, { label: "b", warehouse: south } as any);
      await em.save(Shelf, { label: "c", warehouse: south } as any);
      await em.save(Shelf, { label: "loose" } as any);
    });

    const targets = (shelves: any[]) =>
      shelves.map((s) => [s.label, s.warehouse?.name ?? null]);
    const EXPECTED = [
      ["a", "north"],
      ["b", "south"],
      ["c", "south"],
      ["loose", null],
    ];

    it("find() joins the target on the referenced column", async () => {
      const shelves = await em.find(Shelf, { relations: ["warehouse"], orderBy: { id: "ASC" } } as any);
      expect(targets(shelves as any[])).toEqual(EXPECTED);
    });

    it("findWithCursor() loads the target by the referenced column", async () => {
      const page = await em.findWithCursor(Shelf, { take: 10, relations: ["warehouse"] } as any);
      expect(targets(page.data as any[])).toEqual(EXPECTED);
    });

    it("a relation select that leaves the referenced column out still matches", async () => {
      const page = await em.findWithCursor(Shelf, {
        take: 10,
        relations: { warehouse: { select: ["name"] } },
      } as any);
      expect(targets(page.data as any[])).toEqual(EXPECTED);
    });

    it("a lazy relation resolves by the referenced column", async () => {
      await em.save(Crate, { label: "c", warehouse: south } as any);
      const crate: any = await em.findOne(Crate, { where: { label: "c" } } as any);
      expect((await crate.warehouse).name).toBe("south");
    });

    it("the inverse OneToMany groups rows by the referenced column", async () => {
      const warehouses = await em.find(Warehouse, { relations: ["shelves"], orderBy: { id: "ASC" } } as any);
      expect(
        (warehouses as any[]).map((w) => [w.name, w.shelves.map((s: any) => s.label).sort()]),
      ).toEqual([
        ["north", ["a"]],
        ["south", ["b", "c"]],
      ]);
    });

    it("a parent select without the referenced column still gets its rows", async () => {
      const warehouses = await em.find(Warehouse, {
        select: ["name"],
        relations: ["shelves"],
        orderBy: { id: "ASC" },
      } as any);
      expect((warehouses as any[]).map((w) => w.shelves.length)).toEqual([1, 2]);
    });

    it("withCount counts by the referenced column", async () => {
      const warehouses = await em.find(Warehouse, {
        withCount: { shelfCount: "shelves" },
        orderBy: { id: "ASC" },
      } as any);
      expect((warehouses as any[]).map((w) => [w.name, w.shelfCount])).toEqual([
        ["north", 1],
        ["south", 2],
      ]);
    });

    it("nested relations follow the referenced column both ways", async () => {
      const shelves = await em.find(Shelf, {
        where: { label: "b" },
        relations: { warehouse: { relations: { shelves: true } } },
      } as any);
      const [shelf] = shelves as any[];
      expect(shelf.warehouse.name).toBe("south");
      expect(shelf.warehouse.shelves.map((s: any) => s.label).sort()).toEqual(["b", "c"]);
    });
  });

  describe("cascades", () => {
    it("a cascaded ManyToOne target contributes its referenced column", async () => {
      await em.save(Shelf, { label: "a", warehouse: { code: 30, name: "east" } } as any);
      expect(await shelfRows()).toEqual([{ label: "a", warehouse_code: 30 }]);
    });

    it("cascaded OneToMany rows take the parent's referenced column", async () => {
      await em.save(Warehouse, {
        code: 40,
        name: "west",
        shelves: [{ label: "x" }, { label: "y" }],
      } as any);
      expect(await shelfRows()).toEqual([
        { label: "x", warehouse_code: 40 },
        { label: "y", warehouse_code: 40 },
      ]);
    });

    it("refuses to cascade rows when the parent does not state the referenced column", async () => {
      await expect(
        em.save(Warehouse, { id: north.id, shelves: [{ label: "x" }] } as any),
      ).rejects.toBeInstanceOf(OrmError);
      expect(await shelfRows()).toEqual([]);
    });

    it("delete removes the rows that reference the deleted parent", async () => {
      await em.save(Shelf, { label: "a", warehouse: north } as any);
      await em.save(Shelf, { label: "b", warehouse: south } as any);

      await em.delete(Warehouse, { id: south.id } as any);

      expect(await shelfRows()).toEqual([{ label: "a", warehouse_code: 20 }]);
    });
  });
});
