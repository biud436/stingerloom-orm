/**
 * A read of the root of an inheritance hierarchy may name its subclasses'
 * columns — the root's column scope already accepted them — and builds each
 * row with its subclass's columns.
 *
 * - JOINED: every read of the root named a subclass column on the root's
 *   table, so where / orderBy / count / sum / exists / a cursor page / the
 *   query builder failed with "no such column", and so did a relation's
 *   where / orderBy / withCount and a relation filter targeting the root.
 * - TABLE_PER_CLASS: a subclass property whose column has another name
 *   (`@Column({ name })`) was left unmapped and failed the same way.
 * - SINGLE_TABLE: the root read left out the join columns of the relations
 *   a subclass declares, so its instances lacked their FK shadows.
 */
import "reflect-metadata";
import { Entity } from "../../../../src/decorators/Entity";
import { Column } from "../../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../../src/decorators/OneToMany";
import { ManyToMany } from "../../../../src/decorators/ManyToMany";
import { RelationColumn } from "../../../../src/decorators/RelationColumn";
import { Inheritance } from "../../../../src/decorators/Inheritance";
import { DiscriminatorColumn } from "../../../../src/decorators/DiscriminatorColumn";
import { DiscriminatorValue } from "../../../../src/decorators/DiscriminatorValue";
import { Relation } from "../../../../src/types/Relation";
import { EntityManager } from "../../../../src/core/EntityManager";

@Entity({ name: "prs_owners" })
class PrsOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => PrsAsset, { mappedBy: "owner" }) assets!: PrsAsset[];
  @ManyToMany(() => PrsAsset, {
    joinTable: { name: "prs_owner_favorites", joinColumn: "owner_id", inverseJoinColumn: "asset_id" },
  })
  favorites!: PrsAsset[];
}

@Entity({ name: "prs_assets" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class PrsAsset {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
  @ManyToOne(() => PrsOwner, (o: PrsOwner) => o.assets)
  @RelationColumn({ name: "owner_id", nullable: true })
  owner!: Relation<PrsOwner> | null;
}

@Entity({ name: "prs_cars" })
@DiscriminatorValue("car")
class PrsCar extends PrsAsset {
  @Column({ name: "wheel_count", type: "int", nullable: true }) wheelCount!: number | null;
  /** Declared by both subclasses: each table holds its own. */
  @Column({ type: "int", nullable: true }) rating!: number | null;
}

@Entity({ name: "prs_boats" })
@DiscriminatorValue("boat")
class PrsBoat extends PrsAsset {
  @Column({ type: "int", nullable: true }) sails!: number | null;
  @Column({ type: "int", nullable: true }) rating!: number | null;
}

@Entity({ name: "prs_payments" })
@Inheritance({ strategy: "TABLE_PER_CLASS" })
class PrsPayment {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) amount!: number;
}

@Entity({ name: "prs_card_payments" })
@DiscriminatorValue("card")
class PrsCardPayment extends PrsPayment {
  @Column({ name: "card_last4", type: "varchar", length: 4, nullable: true }) cardLast4!: string | null;
}

@Entity({ name: "prs_holders" })
class PrsHolder {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
}

@Entity({ name: "prs_tickets" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "ttype" })
class PrsTicket {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) code!: string;
}

@Entity()
@DiscriminatorValue("member")
class PrsMemberTicket extends PrsTicket {
  @ManyToOne(() => PrsHolder, (h: PrsHolder) => h.id)
  @RelationColumn({ name: "holder_id", nullable: true })
  holder!: Relation<PrsHolder> | null;
}

@Entity()
@DiscriminatorValue("guest")
class PrsGuestTicket extends PrsTicket {
  @Column({ type: "varchar", length: 40, nullable: true }) guestName!: string | null;
}

describe("[Integration] SQLite: subclass columns through a polymorphic root", () => {
  let em: EntityManager;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [
          PrsOwner,
          PrsAsset,
          PrsCar,
          PrsBoat,
          PrsPayment,
          PrsCardPayment,
          PrsHolder,
          PrsTicket,
          PrsMemberTicket,
          PrsGuestTicket,
        ],
        synchronize: true,
        logging: false,
      } as any,
      "prs",
    );
    const alice = await em.save(PrsOwner, { name: "alice" });
    const bob = await em.save(PrsOwner, { name: "bob" });
    ids.alice = alice.id;
    ids.bob = bob.id;
    const car = await em.save(PrsCar, { label: "car", wheelCount: 4, rating: 5, owner: alice });
    const boat = await em.save(PrsBoat, { label: "boat", sails: 2, rating: 3, owner: alice });
    await em.save(PrsAsset, { label: "plot", owner: bob });
    ids.car = car.id;
    ids.boat = boat.id;
    await em.query(
      `INSERT INTO prs_owner_favorites (owner_id, asset_id) VALUES (${alice.id}, ${car.id}), (${alice.id}, ${boat.id})`,
    );

    await em.save(PrsPayment, { amount: 1 });
    await em.save(PrsCardPayment, { amount: 2, cardLast4: "1234" });

    const holder = await em.save(PrsHolder, { name: "h" });
    ids.holder = holder.id;
    await em.save(PrsMemberTicket, { code: "m", holder });
    await em.save(PrsGuestTicket, { code: "g", guestName: "eve" });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  const labels = (rows: Array<{ label: string }>) => rows.map((r) => r.label);

  describe("JOINED root", () => {
    it("filters and orders find() by a subclass column, by property or column name", async () => {
      expect(labels(await em.find(PrsAsset, { where: { wheelCount: 4 } as any }))).toEqual(["car"]);
      expect(labels(await em.find(PrsAsset, { where: { wheel_count: 4 } as any }))).toEqual(["car"]);
      const [car] = await em.find(PrsAsset, { where: { wheelCount: 4 } as any });
      expect(car).toBeInstanceOf(PrsCar);
      expect((car as PrsCar).wheelCount).toBe(4);

      const bySails = await em.find(PrsAsset, { orderBy: { sails: "DESC" } as any, where: { label: { in: ["boat", "car"] } } });
      expect(labels(bySails)[0]).toBe("boat");
    });

    it("reads a column two subclasses declare from whichever table holds the row", async () => {
      const rated = await em.find(PrsAsset, {
        where: { rating: { gte: 3 } } as any,
        orderBy: { rating: "DESC" } as any,
      });
      expect(labels(rated)).toEqual(["car", "boat"]);
      expect(await em.sum(PrsAsset, "rating" as any)).toBe(8);
      expect(await em.count(PrsAsset, { rating: 3 } as any)).toBe(1);
    });

    it("counts, checks and sums by a subclass column", async () => {
      expect(await em.count(PrsAsset, { sails: 2 } as any)).toBe(1);
      expect(await em.exists(PrsAsset, { wheelCount: 4 } as any)).toBe(true);
      expect(await em.sum(PrsAsset, "wheelCount" as any)).toBe(4);
      expect(await em.count(PrsAsset)).toBe(3);

      const [rows, total] = await em.findAndCount(PrsAsset, { where: { sails: 2 } as any });
      expect([labels(rows), total]).toEqual([["boat"], 1]);
      expect(await em.findOne(PrsAsset, { where: { sails: 2 } as any })).toBeInstanceOf(PrsBoat);
    });

    it("plucks a subclass column", async () => {
      const values = await em.pluck(PrsAsset, "wheelCount" as any, { label: { in: ["car", "boat"] } });
      expect([...values].sort()).toEqual([4, undefined].sort());
    });

    it("pages a cursor by a subclass column, and refuses one two subclasses declare", async () => {
      const page = await em.findWithCursor(PrsAsset, { take: 5, where: { sails: 2 } as any });
      expect(labels(page.data)).toEqual(["boat"]);

      const first = await em.findWithCursor(PrsAsset, { take: 1, orderBy: "wheelCount" as any });
      expect(labels(first.data)).toEqual(["car"]);
      const rest = await em.findWithCursor(PrsAsset, {
        take: 5,
        orderBy: "wheelCount" as any,
        cursor: first.nextCursor!,
      });
      expect(labels(rest.data).sort()).toEqual(["boat", "plot"]);

      await expect(
        em.findWithCursor(PrsAsset, { take: 1, orderBy: "rating" as any }),
      ).rejects.toThrow(/each hold a column of that name/);
    });

    it("filters the query builder by a subclass column and builds each row with its properties", async () => {
      const rows = (await em
        .createQueryBuilder(PrsAsset, "a")
        .where("wheelCount", 4)
        .getMany()) as PrsAsset[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBeInstanceOf(PrsCar);
      expect((rows[0] as PrsCar).wheelCount).toBe(4);
      expect("wheel_count" in rows[0]).toBe(false);
      expect("dtype" in rows[0]).toBe(false);

      const qualified = (await em
        .createQueryBuilder(PrsAsset, "a")
        .where("a.sails", 2)
        .getMany()) as PrsAsset[];
      expect(labels(qualified)).toEqual(["boat"]);
    });

    it("filters, orders and counts a relation targeting the root by a subclass column", async () => {
      const alice = (await em.findOne(PrsOwner, {
        where: { id: ids.alice },
        relations: {
          assets: { where: { wheelCount: 4 } as any },
          favorites: { orderBy: { sails: "DESC" } as any, take: 1 },
        },
        withCount: { boats: { relation: "assets", where: { sails: 2 } as any } },
      } as any)) as PrsOwner & { boats: number };
      expect(labels(alice.assets)).toEqual(["car"]);
      expect(labels(alice.favorites)).toEqual(["boat"]);
      expect(alice.boats).toBe(1);
    });

    it("filters by related rows on a subclass column", async () => {
      const owners = await em.find(PrsOwner, {
        where: { assets: { some: { wheelCount: 4 } } } as any,
      });
      expect(owners.map((o) => o.name)).toEqual(["alice"]);
      expect(await em.count(PrsOwner, { assets: { none: { sails: 2 } } } as any)).toBe(1);
    });

    it("still rejects a subclass column in the criteria of a write on the root", async () => {
      await expect(em.delete(PrsAsset, { sails: 2 } as any)).rejects.toThrow(/Unknown column "sails"/);
    });
  });

  describe("TABLE_PER_CLASS root", () => {
    it("maps a renamed subclass property on every read", async () => {
      expect((await em.find(PrsPayment, { where: { cardLast4: "1234" } as any })).map((p) => p.amount)).toEqual([2]);
      expect(await em.count(PrsPayment, { cardLast4: "1234" } as any)).toBe(1);
      const page = await em.findWithCursor(PrsPayment, { take: 5, where: { cardLast4: "1234" } as any });
      expect(page.data.map((p) => p.amount)).toEqual([2]);
      const built = await em.createQueryBuilder(PrsPayment, "p").where("cardLast4", "1234").getMany();
      expect(built.map((p: any) => p.amount)).toEqual([2]);
    });
  });

  describe("SINGLE_TABLE root", () => {
    it("reads the join columns of the relations a subclass declares, on that subclass's rows only", async () => {
      const tickets = await em.find(PrsTicket, { orderBy: { code: "ASC" } });
      const [guest, member] = tickets;
      expect(member).toBeInstanceOf(PrsMemberTicket);
      expect((member as PrsMemberTicket & { holderId: number }).holderId).toBe(ids.holder);
      expect("holderId" in guest).toBe(false);

      const page = await em.findWithCursor(PrsTicket, { take: 5 });
      const pagedMember = page.data.find((t) => t.code === "m") as PrsMemberTicket & { holderId: number };
      expect(pagedMember.holderId).toBe(ids.holder);

      const byHolder = await em.find(PrsTicket, { where: { holderId: ids.holder } as any });
      expect(byHolder.map((t) => t.code)).toEqual(["m"]);
    });
  });
});
