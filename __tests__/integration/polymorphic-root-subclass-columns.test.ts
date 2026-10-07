/**
 * Subclass columns through a polymorphic root on a real PostgreSQL / MySQL
 * (MariaDB): a JOINED root's reads name a subclass column through the
 * subclass table (`COALESCE` over the tables when several subclasses
 * declare it), a TABLE_PER_CLASS root maps a renamed subclass property, and
 * a SINGLE_TABLE root reads the join columns its subclasses' relations use.
 *
 * SQLite: __tests__/integration/sqlite/inheritance/polymorphic-root-subclass-columns.test.ts
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { disableFkChecksSql, enableFkChecksSql } from "./helpers/driver-helpers";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  RelationColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe.each(getTestDrivers())(
  "[Integration] $label: subclass columns through a polymorphic root",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    const ids: Record<string, number> = {};
    const t = {
      owner: shortName("prso"),
      asset: shortName("prsa"),
      car: shortName("prsc"),
      boat: shortName("prsb"),
      payment: shortName("prsp"),
      cardPayment: shortName("prsq"),
      holder: shortName("prsh"),
      ticket: shortName("prst"),
    };

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: t.owner })
          class Owner {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @OneToMany(() => Asset, { mappedBy: "owner" }) assets!: any[];
          }

          @Entity({ name: t.asset })
          @Inheritance({ strategy: "JOINED" })
          @DiscriminatorColumn({ name: "dtype" })
          class Asset {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) label!: string;
            @ManyToOne(() => Owner, (o: any) => o.assets)
            @RelationColumn({ name: "owner_id", nullable: true })
            owner!: any;
          }

          @Entity({ name: t.car })
          @DiscriminatorValue("car")
          class Car extends Asset {
            @Column({ name: "wheel_count", type: "int", nullable: true }) wheelCount!: number | null;
            @Column({ type: "int", nullable: true }) rating!: number | null;
          }

          @Entity({ name: t.boat })
          @DiscriminatorValue("boat")
          class Boat extends Asset {
            @Column({ type: "int", nullable: true }) sails!: number | null;
            @Column({ type: "int", nullable: true }) rating!: number | null;
          }

          @Entity({ name: t.payment })
          @Inheritance({ strategy: "TABLE_PER_CLASS" })
          class Payment {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "int" }) amount!: number;
          }

          @Entity({ name: t.cardPayment })
          @DiscriminatorValue("card")
          class CardPayment extends Payment {
            @Column({ name: "card_last4", type: "varchar", length: 4, nullable: true })
            cardLast4!: string | null;
          }

          @Entity({ name: t.holder })
          class Holder {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
          }

          @Entity({ name: t.ticket })
          @Inheritance({ strategy: "SINGLE_TABLE" })
          @DiscriminatorColumn({ name: "ttype" })
          class Ticket {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) code!: string;
          }

          @Entity()
          @DiscriminatorValue("member")
          class MemberTicket extends Ticket {
            @ManyToOne(() => Holder, (h: any) => h.id)
            @RelationColumn({ name: "holder_id", nullable: true })
            holder!: any;
          }

          @Entity()
          @DiscriminatorValue("guest")
          class GuestTicket extends Ticket {
            @Column({ type: "varchar", length: 40, nullable: true }) guestName!: string | null;
          }

          E = { Owner, Asset, Car, Boat, Payment, CardPayment, Holder, Ticket, MemberTicket, GuestTicket };
          return { entities: Object.values(E) };
        },
      );
      em = conn.em;

      const alice = await em.save(E.Owner, { name: "alice" });
      ids.alice = alice.id;
      await em.save(E.Car, { label: "car", wheelCount: 4, rating: 5, owner: alice });
      await em.save(E.Boat, { label: "boat", sails: 2, rating: 3, owner: alice });
      await em.save(E.Payment, { amount: 1 });
      await em.save(E.CardPayment, { amount: 2, cardLast4: "1234" });
      const holder = await em.save(E.Holder, { name: "h" });
      ids.holder = holder.id;
      await em.save(E.MemberTicket, { code: "m", holder });
      await em.save(E.GuestTicket, { code: "g", guestName: "eve" });
    }, 60000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const name of [t.car, t.boat, t.asset, t.owner, t.cardPayment, t.payment, t.ticket, t.holder]) {
          await dropTestTable(name);
        }
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const labels = (rows: any[]) => rows.map((r) => r.label);

    it("filters, orders, counts and sums a JOINED root by subclass columns", async () => {
      const [car] = await em.find(E.Asset, { where: { wheelCount: 4 } });
      expect(car).toBeInstanceOf(E.Car);
      expect(car.wheelCount).toBe(4);
      expect(labels(await em.find(E.Asset, { orderBy: { rating: "DESC" } }))).toEqual(["car", "boat"]);
      expect(await em.count(E.Asset, { sails: 2 })).toBe(1);
      expect(await em.exists(E.Asset, { wheelCount: 4 })).toBe(true);
      expect(Number(await em.sum(E.Asset, "rating" as any))).toBe(8);
    });

    it("pages a JOINED root by a subclass column and filters the query builder by one", async () => {
      const page = await em.findWithCursor(E.Asset, { take: 1, orderBy: "wheelCount" as any });
      expect(labels(page.data)).toEqual(["car"]);

      const rows = await em.createQueryBuilder(E.Asset, "a").where("a.sails", 2).getMany();
      expect(rows.map((r: any) => [r.constructor, r.sails])).toEqual([[E.Boat, 2]]);
    });

    it("filters a relation and related rows by a subclass column of a JOINED root target", async () => {
      const alice = await em.findOne(E.Owner, {
        where: { id: ids.alice },
        relations: { assets: { where: { wheelCount: 4 } } },
        withCount: { boats: { relation: "assets", where: { sails: 2 } } },
      } as any);
      expect(labels(alice.assets)).toEqual(["car"]);
      expect(alice.boats).toBe(1);
      expect(await em.count(E.Owner, { assets: { some: { sails: 2 } } })).toBe(1);
    });

    it("maps a renamed subclass property of a TABLE_PER_CLASS root", async () => {
      const rows = await em.find(E.Payment, { where: { cardLast4: "1234" } });
      expect(rows.map((p: any) => p.amount)).toEqual([2]);
      expect(await em.count(E.Payment, { cardLast4: "1234" })).toBe(1);
    });

    it("reads a SINGLE_TABLE subclass's relation join column through the root", async () => {
      const tickets = await em.find(E.Ticket, { where: { holderId: ids.holder } });
      expect(tickets.map((x: any) => [x.constructor, x.holderId])).toEqual([[E.MemberTicket, ids.holder]]);
      const guest = (await em.find(E.Ticket, { where: { code: "g" } }))[0];
      expect("holderId" in guest).toBe(false);
    });
  },
);
