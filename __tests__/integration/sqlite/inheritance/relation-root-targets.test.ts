/**
 * Relations whose target is the root of an inheritance hierarchy.
 *
 * A row reached through a relation to the root of a SINGLE_TABLE or JOINED
 * hierarchy is built the way find(Root) builds it: as the subclass its
 * discriminator names, holding that class's columns only.
 *
 * - The to-one JOIN of find() built every row as the root: a SINGLE_TABLE
 *   row carried the discriminator and every sibling's columns as nulls, a
 *   JOINED row lacked its subclass's columns.
 * - The batched reads — a cursor page's to-one read, OneToMany, ManyToMany,
 *   inverse OneToOne — read a JOINED root's table alone, without its
 *   subclasses' columns.
 * - The query builder's relation joins did the same, read a JOINED child's
 *   inherited columns from its own table ("no such column"), and joined a
 *   SINGLE_TABLE child's siblings' rows.
 */
import "reflect-metadata";
import { Entity } from "../../../../src/decorators/Entity";
import { Column } from "../../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../../src/decorators/OneToMany";
import { ManyToMany } from "../../../../src/decorators/ManyToMany";
import { OneToOne } from "../../../../src/decorators/OneToOne";
import { RelationColumn } from "../../../../src/decorators/RelationColumn";
import { Inheritance } from "../../../../src/decorators/Inheritance";
import { DiscriminatorColumn } from "../../../../src/decorators/DiscriminatorColumn";
import { DiscriminatorValue } from "../../../../src/decorators/DiscriminatorValue";
import { DeletedAt } from "../../../../src/decorators/DeletedAt";
import { Relation } from "../../../../src/types/Relation";
import { createTestEntityManager } from "../../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../../src/core/EntityManager";
import { MetadataContext } from "../../../../src/metadata/MetadataContext";

@Entity({ name: "rrt_owners" })
class RrtOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => RrtItem, { mappedBy: "owner" }) items!: RrtItem[];
  @OneToMany(() => RrtAsset, { mappedBy: "owner" }) assets!: RrtAsset[];
  @OneToOne(() => RrtAsset, { inverseSide: "keeper" }) kept!: Relation<RrtAsset> | null;
}

@Entity({ name: "rrt_items" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "item_type" })
class RrtItem {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @ManyToOne(() => RrtOwner, (o: RrtOwner) => o.items)
  @RelationColumn({ name: "owner_id", nullable: true })
  owner!: Relation<RrtOwner> | null;
}

@Entity()
@DiscriminatorValue("pen")
class RrtPen extends RrtItem {
  @Column({ name: "ink_color", type: "varchar", length: 20, nullable: true }) inkColor!: string | null;
}

@Entity()
@DiscriminatorValue("box")
class RrtBox extends RrtItem {
  @Column({ type: "int", nullable: true }) qty!: number | null;
}

@Entity({ name: "rrt_assets" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class RrtAsset {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
  @ManyToOne(() => RrtOwner, (o: RrtOwner) => o.assets)
  @RelationColumn({ name: "owner_id", nullable: true })
  owner!: Relation<RrtOwner> | null;
  @OneToOne(() => RrtOwner)
  @RelationColumn({ name: "keeper_id", nullable: true })
  keeper!: Relation<RrtOwner> | null;
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "rrt_cars" })
@DiscriminatorValue("car")
class RrtCar extends RrtAsset {
  @Column({ name: "wheel_count", type: "int", nullable: true }) wheelCount!: number | null;
}

@Entity({ name: "rrt_boats" })
@DiscriminatorValue("boat")
class RrtBoat extends RrtAsset {
  @Column({ type: "int", nullable: true }) sails!: number | null;
}

@Entity({ name: "rrt_holders" })
class RrtHolder {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) tag!: string;
  @ManyToOne(() => RrtItem, (i: RrtItem) => i.id)
  @RelationColumn({ name: "item_id", nullable: true })
  item!: Relation<RrtItem> | null;
  @OneToOne(() => RrtItem)
  @RelationColumn({ name: "slot_id", nullable: true })
  slot!: Relation<RrtItem> | null;
  @ManyToOne(() => RrtAsset, (a: RrtAsset) => a.id)
  @RelationColumn({ name: "asset_id", nullable: true })
  asset!: Relation<RrtAsset> | null;
  @OneToOne(() => RrtAsset)
  @RelationColumn({ name: "vault_id", nullable: true })
  vault!: Relation<RrtAsset> | null;
  /** A SINGLE_TABLE child target. */
  @ManyToOne(() => RrtPen, (p: RrtPen) => p.id)
  @RelationColumn({ name: "pen_id", nullable: true })
  pen!: Relation<RrtPen> | null;
  /** A JOINED child target. */
  @ManyToOne(() => RrtCar, (c: RrtCar) => c.id)
  @RelationColumn({ name: "car_id", nullable: true })
  car!: Relation<RrtCar> | null;
  @ManyToMany(() => RrtAsset, {
    joinTable: { name: "rrt_holder_assets", joinColumn: "holder_id", inverseJoinColumn: "asset_id" },
  })
  fleet!: RrtAsset[];
}

@Entity({ name: "rrt_t_docs" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class RrtTDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
  @ManyToOne(() => RrtTHolder, (h: RrtTHolder) => h.docs)
  @RelationColumn({ name: "holder_id", nullable: true })
  holder!: Relation<RrtTHolder> | null;
}

@Entity({ name: "rrt_t_reviews" })
@DiscriminatorValue("review")
class RrtTReview extends RrtTDoc {
  @Column({ type: "varchar", length: 40 }) reviewer!: string;
}

@Entity({ name: "rrt_t_holders" })
class RrtTHolder {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) tag!: string;
  @ManyToOne(() => RrtTDoc, (d: RrtTDoc) => d.id)
  @RelationColumn({ name: "doc_id", nullable: true })
  doc!: Relation<RrtTDoc> | null;
  @OneToMany(() => RrtTDoc, { mappedBy: "holder" }) docs!: RrtTDoc[];
}

describe("[Integration] SQLite: relations targeting the root of a hierarchy", () => {
  let em: EntityManager;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [RrtOwner, RrtItem, RrtPen, RrtBox, RrtAsset, RrtCar, RrtBoat, RrtHolder],
      connectionName: "rrt",
    });
    const alice = await em.save(RrtOwner, { name: "alice" });
    const bob = await em.save(RrtOwner, { name: "bob" });
    ids.alice = alice.id;
    ids.bob = bob.id;
    const pen = await em.save(RrtPen, { name: "pen", inkColor: "blue", owner: alice });
    const box = await em.save(RrtBox, { name: "box", qty: 3, owner: alice });
    const car = await em.save(RrtCar, { label: "car", wheelCount: 4, owner: alice, keeper: bob });
    const boat = await em.save(RrtBoat, { label: "boat", sails: 2, owner: alice });
    const wreck = await em.save(RrtBoat, { label: "wreck", sails: 0, owner: alice });
    await em.softDelete(RrtBoat, { id: wreck.id });
    ids.pen = pen.id;
    ids.box = box.id;
    ids.car = car.id;
    ids.boat = boat.id;
    ids.wreck = wreck.id;

    // `pen` points at the box: a sibling of the declared subtype.
    const full = await em.save(RrtHolder, { tag: "full", item: pen, slot: box, asset: boat, vault: car, car });
    await em.updateMany(RrtHolder, { penId: box.id } as any, { where: { id: full.id } });
    const empty = await em.save(RrtHolder, { tag: "empty" });
    const trashed = await em.save(RrtHolder, { tag: "trashed", asset: wreck });
    ids.full = full.id;
    ids.empty = empty.id;
    ids.trashed = trashed.id;
    await em.query(
      `INSERT INTO rrt_holder_assets (holder_id, asset_id) VALUES (${full.id}, ${car.id}), (${full.id}, ${boat.id})`,
    );
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const fullHolder = (relations: any) =>
    em.findOne(RrtHolder, { where: { id: ids.full }, relations }) as Promise<RrtHolder>;

  describe("find() JOIN", () => {
    it("builds a SINGLE_TABLE root target as its subclass, with that class's columns only", async () => {
      const holder = await fullHolder(["item", "slot"]);
      expect(holder.item).toBeInstanceOf(RrtPen);
      expect(plain(holder.item)).toEqual({ id: ids.pen, name: "pen", inkColor: "blue", ownerId: ids.alice, owner: null });
      expect(holder.slot).toBeInstanceOf(RrtBox);
      expect(plain(holder.slot)).toEqual({ id: ids.box, name: "box", qty: 3, ownerId: ids.alice, owner: null });
    });

    it("builds a JOINED root target as its subclass, with its own table's columns", async () => {
      const holder = await fullHolder(["asset", "vault"]);
      expect(holder.asset).toBeInstanceOf(RrtBoat);
      expect(plain(holder.asset)).toEqual({
        id: ids.boat,
        label: "boat",
        ownerId: ids.alice,
        keeperId: null,
        deletedAt: null,
        sails: 2,
        owner: null,
        keeper: null,
      });
      expect(holder.vault).toBeInstanceOf(RrtCar);
      expect((holder.vault as RrtCar).wheelCount).toBe(4);
      expect("sails" in holder.vault!).toBe(false);
    });

    it("answers the instance find() on the root answers", async () => {
      const holder = await fullHolder(["asset", "item"]);
      const [boat] = await em.find(RrtAsset, { where: { id: ids.boat } });
      const [pen] = await em.find(RrtItem, { where: { id: ids.pen } });
      // A JOINed target's own to-one relations, not loaded, read null.
      const { owner: assetOwner, keeper, ...asset } = plain(holder.asset);
      const { owner: itemOwner, ...item } = plain(holder.item);
      expect([assetOwner, keeper, itemOwner]).toEqual([null, null, null]);
      expect(asset).toEqual(plain(boat));
      expect(item).toEqual(plain(pen));
    });

    it("keeps a missing or soft-deleted target null", async () => {
      const empty = await em.findOne(RrtHolder, { where: { id: ids.empty }, relations: ["item", "asset"] });
      expect(empty!.item).toBeNull();
      expect(empty!.asset).toBeNull();

      const trashed = await em.findOne(RrtHolder, { where: { id: ids.trashed }, relations: ["asset"] });
      expect(trashed!.asset).toBeNull();
      const withDeleted = await em.findOne(RrtHolder, {
        where: { id: ids.trashed },
        relations: ["asset"],
        withDeleted: true,
      });
      expect(withDeleted!.asset).toBeInstanceOf(RrtBoat);
      expect((withDeleted!.asset as RrtBoat).sails).toBe(0);
    });

    it("loads a nested relation on the subclass instance", async () => {
      const holder = await fullHolder({ vault: { relations: { keeper: true } }, item: { relations: { owner: true } } });
      expect(holder.vault).toBeInstanceOf(RrtCar);
      expect(holder.vault!.keeper?.name).toBe("bob");
      expect(holder.item).toBeInstanceOf(RrtPen);
      expect(holder.item!.owner?.name).toBe("alice");
    });
  });

  describe("batched reads", () => {
    it("builds the to-one targets of a cursor page as their subclasses", async () => {
      const page = await em.findWithCursor(RrtHolder, {
        take: 5,
        where: { id: ids.full },
        relations: ["item", "asset"],
      });
      const [holder] = page.data;
      expect(holder.item).toBeInstanceOf(RrtPen);
      expect(holder.asset).toBeInstanceOf(RrtBoat);
      expect(plain(holder.asset)).toEqual({
        id: ids.boat,
        label: "boat",
        ownerId: ids.alice,
        keeperId: null,
        deletedAt: null,
        sails: 2,
      });
    });

    it("builds a OneToMany targeting a JOINED root as subclasses, filtered and paged", async () => {
      const owner = await em.findOne(RrtOwner, {
        where: { id: ids.alice },
        relations: { assets: { orderBy: { label: "ASC" } } },
      });
      expect(owner!.assets.map((a) => [a.constructor, a.label])).toEqual([
        [RrtBoat, "boat"],
        [RrtCar, "car"],
      ]);
      expect((owner!.assets[0] as RrtBoat).sails).toBe(2);
      expect((owner!.assets[1] as RrtCar).wheelCount).toBe(4);
      expect("wheelCount" in owner!.assets[0]).toBe(false);

      const paged = await em.findOne(RrtOwner, {
        where: { id: ids.alice },
        relations: { assets: { where: { label: { startsWith: "c" } }, orderBy: { label: "DESC" }, take: 1, withDeleted: true } },
      });
      expect(paged!.assets.map((a) => [a.constructor, a.label])).toEqual([[RrtCar, "car"]]);
    });

    it("builds a ManyToMany and an inverse OneToOne targeting a JOINED root as subclasses", async () => {
      const holder = await fullHolder({ fleet: { orderBy: { label: "ASC" } } });
      expect(holder.fleet.map((a) => a.constructor)).toEqual([RrtBoat, RrtCar]);
      expect((holder.fleet[1] as RrtCar).wheelCount).toBe(4);

      const bob = await em.findOne(RrtOwner, { where: { id: ids.bob }, relations: ["kept"] });
      expect(bob!.kept).toBeInstanceOf(RrtCar);
      expect((bob!.kept as RrtCar).wheelCount).toBe(4);
    });

    it("counts a OneToMany targeting a JOINED root", async () => {
      const owner = await em.findOne(RrtOwner, {
        where: { id: ids.alice },
        withCount: { assetCount: "assets", itemCount: "items" },
      } as any);
      expect((owner as any).assetCount).toBe(2);
      expect((owner as any).itemCount).toBe(2);
    });
  });

  describe("SelectQueryBuilder relation joins", () => {
    it("builds the selected root targets as their subclasses", async () => {
      const [holder] = (await em
        .createQueryBuilder(RrtHolder, "h")
        .leftJoinRelationAndSelect("item", "i")
        .leftJoinRelationAndSelect("asset", "a")
        .leftJoinRelationAndSelect("vault", "v")
        .where({ id: ids.full })
        .getMany()) as RrtHolder[];
      expect(holder.item).toBeInstanceOf(RrtPen);
      expect(plain(holder.item)).toEqual({ id: ids.pen, name: "pen", inkColor: "blue", ownerId: ids.alice });
      expect(holder.asset).toBeInstanceOf(RrtBoat);
      expect((holder.asset as RrtBoat).sails).toBe(2);
      expect("dtype" in holder.asset!).toBe(false);
      expect(holder.vault).toBeInstanceOf(RrtCar);
      expect((holder.vault as RrtCar).wheelCount).toBe(4);
    });

    it("groups a OneToMany targeting a JOINED root as subclasses", async () => {
      const [owner] = (await em
        .createQueryBuilder(RrtOwner, "o")
        .leftJoinRelationAndSelect("assets", "a")
        .where({ id: ids.alice })
        .addOrderBy("a.label", "ASC")
        .getMany()) as RrtOwner[];
      expect(owner.assets.map((a) => [a.constructor, a.label])).toEqual([
        [RrtBoat, "boat"],
        [RrtCar, "car"],
      ]);
    });

    it("reads a JOINED child target's inherited columns, selected or filtered on", async () => {
      const [holder] = (await em
        .createQueryBuilder(RrtHolder, "h")
        .leftJoinRelationAndSelect("car", "c")
        .where({ id: ids.full })
        .getMany()) as RrtHolder[];
      expect(holder.car).toBeInstanceOf(RrtCar);
      expect(holder.car).toMatchObject({ label: "car", wheelCount: 4, ownerId: ids.alice });

      const count = await em
        .createQueryBuilder(RrtHolder, "h")
        .innerJoinRelation("car", "c")
        .where("c.label", "car")
        .getCount();
      expect(count).toBe(1);
    });

    it("leaves a SINGLE_TABLE child target null when the key points at a sibling", async () => {
      const [holder] = (await em
        .createQueryBuilder(RrtHolder, "h")
        .leftJoinRelationAndSelect("pen", "p")
        .where({ id: ids.full })
        .getMany()) as RrtHolder[];
      expect(holder.pen).toBeNull();

      const count = await em
        .createQueryBuilder(RrtHolder, "h")
        .innerJoinRelation("pen", "p")
        .getCount();
      expect(count).toBe(0);
    });
  });
});

describe("[Integration] SQLite: relations targeting a JOINED root under tenant_column", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [RrtTDoc, RrtTReview, RrtTHolder],
        synchronize: true,
        logging: false,
        tenantStrategy: "tenant_column",
      } as any,
      "rrt_tenant",
    );
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("reads the caller's tenant's target as its subclass and another tenant's as null", async () => {
    const foreign = await MetadataContext.run("beta", () =>
      em.save(RrtTReview, { title: "beta", reviewer: "b" }),
    );
    await MetadataContext.run("acme", async () => {
      const own = await em.save(RrtTReview, { title: "acme", reviewer: "a" });
      const holder = await em.save(RrtTHolder, { tag: "own", doc: own });
      await em.updateMany(RrtTReview, { holderId: holder.id } as any, { where: { id: own.id } });
      const stray = await em.save(RrtTHolder, { tag: "stray" });
      await em.updateMany(RrtTHolder, { docId: foreign.id } as any, { where: { id: stray.id } });

      const found = await em.find(RrtTHolder, { relations: ["doc", "docs"], orderBy: { id: "ASC" } });
      expect(found.map((h) => h.doc?.constructor)).toEqual([RrtTReview, undefined]);
      expect((found[0].doc as RrtTReview).reviewer).toBe("a");
      expect(found[0].docs.map((d) => [d.constructor, (d as RrtTReview).reviewer])).toEqual([[RrtTReview, "a"]]);

      const page = await em.findWithCursor(RrtTHolder, { take: 5, relations: ["doc"] });
      expect(page.data.map((h) => (h.doc as RrtTReview | null)?.reviewer ?? null)).toEqual(["a", null]);

      const built = (await em
        .createQueryBuilder(RrtTHolder, "h")
        .leftJoinRelationAndSelect("doc", "d")
        .addOrderBy("h.id", "ASC")
        .getMany()) as RrtTHolder[];
      expect(built.map((h) => (h.doc as RrtTReview | null)?.reviewer ?? null)).toEqual(["a", null]);
    });
  });
});
