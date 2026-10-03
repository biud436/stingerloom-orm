/**
 * Relations whose target sits in an inheritance hierarchy, on a real
 * PostgreSQL / MySQL (MariaDB):
 *
 * - a JOINED child target is read as its table joined to the root's — the
 *   to-one JOIN, the batched OneToMany / ManyToMany / inverse OneToOne
 *   reads, per-parent paging over an inherited column;
 * - a SINGLE_TABLE child target is limited to its subtype, and a root target
 *   builds each row as its subclass.
 *
 * SQLite: __tests__/integration/sqlite/inheritance/joined-child-relation-targets.test.ts,
 * __tests__/integration/sqlite/inheritance/sti-relation-targets.test.ts
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
  ManyToMany,
  OneToOne,
  RelationColumn,
  DeletedAt,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe.each(getTestDrivers())(
  "[Integration] $label: relations targeting an inheritance hierarchy",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    const t = {
      owner: shortName("irto"),
      asset: shortName("irta"),
      vehicle: shortName("irtv"),
      trip: shortName("irtt"),
      garage: shortName("irtg"),
      garageVehicles: shortName("irtgv"),
      post: shortName("irtp"),
      comment: shortName("irtc"),
    };
    const ids: Record<string, number> = {};

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: t.owner })
          class Owner {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @OneToMany(() => Vehicle, { mappedBy: "owner" }) vehicles!: any[];
            @OneToMany(() => Vehicle, { mappedBy: "driver" }) driven!: any[];
            @OneToOne(() => Vehicle, { inverseSide: "keeper" }) kept!: any;
          }

          @Entity({ name: t.asset })
          @Inheritance({ strategy: "JOINED" })
          @DiscriminatorColumn({ name: "dtype" })
          class Asset {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) label!: string;
            @ManyToOne(() => Owner, (o: any) => o.vehicles)
            @RelationColumn({ name: "owner_id", nullable: true })
            owner!: any;
            @DeletedAt() deletedAt!: Date | null;
          }

          @Entity({ name: t.vehicle })
          @DiscriminatorValue("vehicle")
          class Vehicle extends Asset {
            @Column({ type: "int" }) wheels!: number;
            @ManyToOne(() => Owner, (o: any) => o.driven)
            @RelationColumn({ name: "driver_id", nullable: true })
            driver!: any;
            @OneToOne(() => Owner)
            @RelationColumn({ name: "keeper_id", nullable: true })
            keeper!: any;
          }

          @Entity({ name: t.trip })
          class Trip {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) dest!: string;
            @ManyToOne(() => Vehicle, (v: any) => v.id)
            @RelationColumn({ name: "vehicle_id", nullable: true })
            vehicle!: any;
          }

          @Entity({ name: t.garage })
          class Garage {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) city!: string;
            @ManyToMany(() => Vehicle, {
              joinTable: { name: t.garageVehicles, joinColumn: "garage_id", inverseJoinColumn: "vehicle_id" },
            })
            vehicles!: any[];
          }

          @Entity({ name: t.post })
          class Post {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) title!: string;
            @OneToMany(() => Comment, { mappedBy: "post" }) comments!: any[];
            @OneToMany(() => Premium, { mappedBy: "post" }) premiumComments!: any[];
          }

          @Entity({ name: t.comment })
          @Inheritance({ strategy: "SINGLE_TABLE" })
          @DiscriminatorColumn({ name: "kind" })
          class Comment {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) body!: string;
            @ManyToOne(() => Post, (p: any) => p.comments)
            @RelationColumn({ name: "post_id", nullable: true })
            post!: any;
          }

          @Entity()
          @DiscriminatorValue("premium")
          class Premium extends Comment {
            @Column({ type: "int", nullable: true }) tier!: number | null;
          }

          @Entity()
          @DiscriminatorValue("plain")
          class Plain extends Comment {
            @Column({ type: "varchar", length: 10, nullable: true }) mood!: string | null;
          }

          E = { Owner, Asset, Vehicle, Trip, Garage, Post, Comment, Premium, Plain };
          return { entities: Object.values(E) };
        },
      );
      em = conn.em;

      const alice = await em.save(E.Owner, { name: "alice" });
      const bob = await em.save(E.Owner, { name: "bob" });
      ids.alice = alice.id;
      ids.bob = bob.id;
      const truck = await em.save(E.Vehicle, { label: "truck", wheels: 6, owner: alice, driver: bob, keeper: bob });
      const van = await em.save(E.Vehicle, { label: "van", wheels: 4, owner: alice, driver: alice });
      const gone = await em.save(E.Vehicle, { label: "gone", wheels: 2, owner: alice });
      await em.softDelete(E.Vehicle, { id: gone.id });
      ids.trip = (await em.save(E.Trip, { dest: "coast", vehicle: truck })).id;
      const garage = await em.save(E.Garage, { city: "seoul" });
      ids.garage = garage.id;
      const q = (name: string) => (type === "postgres" ? `"${name}"` : `\`${name}\``);
      await rawQuery(
        `INSERT INTO ${q(t.garageVehicles)} (${q("garage_id")}, ${q("vehicle_id")}) VALUES (${garage.id}, ${truck.id}), (${garage.id}, ${van.id})`,
      );

      const post = await em.save(E.Post, { title: "p1" });
      ids.post = post.id;
      await em.save(E.Plain, { body: "plain", mood: "ok", post });
      await em.save(E.Premium, { body: "premium", tier: 2, post });
      await em.save(E.Premium, { body: "premium-2", tier: 1, post });
    }, 60000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const name of [t.garageVehicles, t.garage, t.trip, t.vehicle, t.asset, t.owner, t.comment, t.post]) {
          await dropTestTable(name);
        }
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    describe("JOINED child target", () => {
      it("JOINs a ManyToOne with the inherited columns, and on a cursor page", async () => {
        const trip = await em.findOne(E.Trip, { where: { id: ids.trip }, relations: ["vehicle"] });
        expect(trip.vehicle).toMatchObject({ label: "truck", wheels: 6 });
        const page = await em.findWithCursor(E.Trip, { take: 5, relations: ["vehicle"] });
        expect(page.data[0].vehicle).toMatchObject({ label: "truck", wheels: 6 });
      });

      it("batches a OneToMany, filters and pages it by an inherited column", async () => {
        const owner = await em.findOne(E.Owner, {
          where: { id: ids.alice },
          relations: { vehicles: { orderBy: { label: "ASC" } }, driven: true },
        });
        expect(owner.vehicles.map((v: any) => [v.label, v.wheels])).toEqual([["truck", 6], ["van", 4]]);
        expect(owner.driven.map((v: any) => v.label)).toEqual(["van"]);

        const paged = await em.findOne(E.Owner, {
          where: { id: ids.alice },
          relations: { vehicles: { where: { label: { startsWith: "t" } }, orderBy: { label: "DESC" }, take: 1 } },
        });
        expect(paged.vehicles.map((v: any) => v.label)).toEqual(["truck"]);
      });

      it("reads a ManyToMany and an inverse OneToOne", async () => {
        const garage = await em.findOne(E.Garage, {
          where: { id: ids.garage },
          relations: { vehicles: { orderBy: { label: "ASC" }, take: 5 } },
        });
        expect(garage.vehicles.map((v: any) => v.label)).toEqual(["truck", "van"]);

        const bob = await em.findOne(E.Owner, { where: { id: ids.bob }, relations: ["kept"] });
        expect(bob.kept).toMatchObject({ label: "truck", wheels: 6 });
      });
    });

    describe("SINGLE_TABLE target", () => {
      it("limits a child target to its subtype and builds a root target's rows as their subclasses", async () => {
        const post = await em.findOne(E.Post, {
          where: { id: ids.post },
          relations: { premiumComments: { orderBy: { tier: "ASC" }, take: 1 }, comments: true },
        });
        expect(post.premiumComments.map((c: any) => c.body)).toEqual(["premium-2"]);
        expect(post.premiumComments[0]).toBeInstanceOf(E.Premium);

        const byBody = Object.fromEntries(post.comments.map((c: any) => [c.body, c]));
        expect(Object.keys(byBody).sort()).toEqual(["plain", "premium", "premium-2"]);
        expect(byBody.plain).toBeInstanceOf(E.Plain);
        expect(byBody.premium).toBeInstanceOf(E.Premium);
        expect("mood" in byBody.premium).toBe(false);
      });
    });
  },
);
