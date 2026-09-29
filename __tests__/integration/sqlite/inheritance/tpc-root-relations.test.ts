/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: relations on a TABLE_PER_CLASS root.
 *
 * A polymorphic root read goes through a UNION ALL over every concrete table,
 * and that UNION listed only the hierarchy's `@Column`s — never a relation's
 * join column. So on the root:
 *
 * - every instance came back without `${relation}Id`, and `pluck()` of it
 *   answered `null` for every row;
 * - `where: { ownerId }` failed in find(), count(), findWithCursor() and the
 *   SelectQueryBuilder with `no such column`;
 * - `relations: ["owner"]` failed on the root's table name, and
 *   findWithCursor() with the same relations answered `owner: null` for
 *   every row.
 *
 * A OneToMany or inverse OneToOne whose target is the root read the root's
 * own table only, leaving out every subclass row. And each row carried its
 * siblings' columns as NULL properties (`floors: null` on a vehicle).
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorValue,
  ManyToOne,
  OneToMany,
  OneToOne,
  RelationColumn,
} from "../../../../src";
import { EntityManager } from "../../../../src/core/EntityManager";

@Entity({ name: "trr_owner" })
class TrrOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @OneToMany(() => TrrAsset, { mappedBy: "owner" }) assets!: TrrAsset[];
  @OneToOne(() => TrrAsset, { inverseSide: "keeper" }) kept!: TrrAsset | null;
}

@Entity({ name: "trr_asset" })
@Inheritance({ strategy: "TABLE_PER_CLASS" })
class TrrAsset {
  @PrimaryGeneratedColumn() id!: number;
  @Column() label!: string;
  @ManyToOne(() => TrrOwner, (o: any) => o.assets)
  @RelationColumn({ name: "owner_id" })
  owner!: TrrOwner | null;
  @Column({ type: "int", nullable: true }) keeperId!: number | null;
  @OneToOne(() => TrrOwner, { joinColumn: "keeperId", inverseSide: "kept" })
  keeper!: TrrOwner | null;
}

@Entity({ name: "trr_vehicle" })
@DiscriminatorValue("vehicle")
class TrrVehicle extends TrrAsset {
  @Column({ nullable: true }) wheels!: number;
  @ManyToOne(() => TrrOwner, (o: any) => o.driven)
  @RelationColumn({ name: "driver_id" })
  driver!: TrrOwner | null;
}

@Entity({ name: "trr_building" })
@DiscriminatorValue("building")
class TrrBuilding extends TrrAsset {
  @Column({ nullable: true }) floors!: number;
}

describe("[Integration] SQLite: relations on a TABLE_PER_CLASS root", () => {
  let em: EntityManager;
  let alice: TrrOwner;
  let bob: TrrOwner;

  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const byLabel = (rows: any[]) =>
    [...rows].sort((a, b) => String(a.label).localeCompare(String(b.label)));

  beforeEach(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [TrrOwner, TrrAsset, TrrVehicle, TrrBuilding],
        synchronize: true,
        logging: false,
      } as any,
      `trr_${Math.random().toString(36).slice(2, 10)}`,
    );
    alice = await em.save(TrrOwner, { name: "alice" } as any);
    bob = await em.save(TrrOwner, { name: "bob" } as any);
    // Each concrete table numbers its own keys: all three rows have id 1.
    await em.save(TrrVehicle, {
      label: "car",
      wheels: 4,
      owner: alice,
      driver: bob,
      keeperId: bob.id,
    } as any);
    await em.save(TrrBuilding, { label: "house", floors: 2, owner: bob } as any);
    await em.save(TrrAsset, { label: "plot", owner: alice } as any);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  describe("find() on the root", () => {
    it("reads each row's join columns and none of its siblings' columns", async () => {
      const rows = byLabel(await em.find(TrrAsset));

      expect(rows.map((r) => r.constructor)).toEqual([TrrVehicle, TrrBuilding, TrrAsset]);
      const [car, house, plot] = rows.map(plain);
      expect(car).toEqual({
        id: 1,
        label: "car",
        ownerId: alice.id,
        keeperId: bob.id,
        wheels: 4,
        driverId: bob.id,
        dtype: "vehicle",
      });
      expect(house).toEqual({
        id: 1,
        label: "house",
        ownerId: bob.id,
        keeperId: null,
        floors: 2,
        dtype: "building",
      });
      expect(plot).toEqual({
        id: 1,
        label: "plot",
        ownerId: alice.id,
        keeperId: null,
        dtype: "TrrAsset",
      });
    });

    it("loads a root relation into every subclass instance", async () => {
      const rows = byLabel(
        await em.find(TrrAsset, { relations: ["owner", "keeper"] } as any),
      );

      expect(rows.map((r) => r.constructor)).toEqual([TrrVehicle, TrrBuilding, TrrAsset]);
      expect(rows.map((r) => [r.owner?.name, r.keeper?.name ?? null])).toEqual([
        ["alice", "bob"],
        ["bob", null],
        ["alice", null],
      ]);
      expect(plain(rows[0])).toMatchObject({ ownerId: alice.id, driverId: bob.id });
    });

    it("filters by a root relation's key with and without relations", async () => {
      const plain_ = await em.find(TrrAsset, { where: { ownerId: alice.id } } as any);
      expect(byLabel(plain_).map((r) => r.label)).toEqual(["car", "plot"]);

      const withOwner = await em.find(TrrAsset, {
        where: { ownerId: bob.id },
        relations: ["owner"],
      } as any);
      expect(withOwner.map((r) => [r.label, r.owner?.name])).toEqual([["house", "bob"]]);
    });

    it("findOne() with relations reads the UNION, not the root's table", async () => {
      const car = await em.findOne(TrrAsset, {
        where: { label: "car" },
        relations: ["owner"],
      } as any);

      expect(car).toBeInstanceOf(TrrVehicle);
      expect(car?.owner?.name).toBe("alice");
    });

    it("counts, pages and plucks by a root relation's key", async () => {
      expect(await em.count(TrrAsset, { ownerId: alice.id } as any)).toBe(2);
      expect(await em.exists(TrrAsset, { ownerId: bob.id } as any)).toBe(true);

      const [rows, total] = await em.findAndCount(TrrAsset, {
        where: { ownerId: alice.id },
        relations: ["owner"],
      } as any);
      expect(total).toBe(2);
      expect(rows.every((r) => r.owner?.name === "alice")).toBe(true);

      const owners = await em.pluck(TrrAsset, "ownerId" as any);
      expect([...owners].sort()).toEqual([alice.id, alice.id, bob.id].sort());
    });

    it("keeps rejecting a subclass relation on the root", async () => {
      await expect(
        em.find(TrrAsset, { relations: ["driver"] } as any),
      ).rejects.toThrow(/Unknown relation "driver"/);
    });
  });

  describe("findWithCursor() on the root", () => {
    it("loads a root relation into every row of the page", async () => {
      const page = await em.findWithCursor(TrrAsset, {
        take: 10,
        relations: ["owner"],
      } as any);

      expect(byLabel(page.data).map((r) => [r.constructor, r.owner?.name])).toEqual([
        [TrrVehicle, "alice"],
        [TrrBuilding, "bob"],
        [TrrAsset, "alice"],
      ]);
    });

    it("filters by a root relation's key", async () => {
      const page = await em.findWithCursor(TrrAsset, {
        take: 10,
        where: { ownerId: alice.id },
      } as any);

      expect(byLabel(page.data).map((r) => r.label)).toEqual(["car", "plot"]);
      expect(plain(byLabel(page.data)[0])).not.toHaveProperty("floors");
    });
  });

  describe("relations targeting the root", () => {
    it("loads a OneToMany from every concrete table, each row as its subclass", async () => {
      const owners = await em.find(TrrOwner, {
        relations: ["assets"],
        orderBy: { id: "ASC" },
      } as any);

      const assets = owners.map((o) =>
        byLabel(o.assets).map((a) => `${a.constructor.name}:${a.label}`),
      );
      expect(assets).toEqual([
        ["TrrVehicle:car", "TrrAsset:plot"],
        ["TrrBuilding:house"],
      ]);
      expect(plain(byLabel(owners[0].assets)[0])).toMatchObject({
        wheels: 4,
        driverId: bob.id,
      });
    });

    it("loads an inverse OneToOne whose owning row is a subclass's", async () => {
      const owners = await em.find(TrrOwner, {
        relations: ["kept"],
        orderBy: { id: "ASC" },
      } as any);

      expect(owners.map((o) => o.kept?.label ?? null)).toEqual([null, "car"]);
      expect(owners[1].kept).toBeInstanceOf(TrrVehicle);
    });
  });

  describe("SelectQueryBuilder on the root", () => {
    it("filters and counts by a root relation's key", async () => {
      const qb = () => em.createQueryBuilder(TrrAsset, "a").where("ownerId" as any, alice.id);

      expect(byLabel(await qb().getMany()).map((r) => r.label)).toEqual(["car", "plot"]);
      expect(await qb().getCount()).toBe(2);
    });
  });
});
