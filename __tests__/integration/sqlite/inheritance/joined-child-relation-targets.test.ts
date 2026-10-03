/**
 * Relations whose target is a child of a JOINED (table-per-type) hierarchy.
 *
 * A JOINED child's row is split between its own table and the root's, which
 * holds every inherited column. The relation reads named the child's table
 * alone and selected the inherited columns from it, so every relation that
 * targets a child failed with "no such column" — the JOIN of a ManyToOne /
 * owning OneToOne, the batched OneToMany / ManyToMany / inverse OneToOne
 * reads and the to-one reads of a cursor page. They now read the child the
 * way find(Child) does: its table joined to the root's.
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

@Entity({ name: "jcr_owners" })
class JcrOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  /** FK declared on the root (inherited by the child). */
  @OneToMany(() => JcrVehicle, { mappedBy: "owner" }) vehicles!: JcrVehicle[];
  /** FK declared on the child itself. */
  @OneToMany(() => JcrVehicle, { mappedBy: "driver" }) driven!: JcrVehicle[];
  /** Inverse side; the child holds the join column. */
  @OneToOne(() => JcrVehicle, { inverseSide: "keeper" }) kept!: Relation<JcrVehicle> | null;
}

@Entity({ name: "jcr_assets" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class JcrAsset {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
  @ManyToOne(() => JcrOwner, (o: JcrOwner) => o.vehicles)
  @RelationColumn({ name: "owner_id", nullable: true })
  owner!: Relation<JcrOwner> | null;
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "jcr_vehicles" })
@DiscriminatorValue("vehicle")
class JcrVehicle extends JcrAsset {
  @Column({ type: "int" }) wheels!: number;
  @ManyToOne(() => JcrOwner, (o: JcrOwner) => o.driven)
  @RelationColumn({ name: "driver_id", nullable: true })
  driver!: Relation<JcrOwner> | null;
  @OneToOne(() => JcrOwner)
  @RelationColumn({ name: "keeper_id", nullable: true })
  keeper!: Relation<JcrOwner> | null;
}

@Entity({ name: "jcr_trips" })
class JcrTrip {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) dest!: string;
  @ManyToOne(() => JcrVehicle, (v: JcrVehicle) => v.id)
  @RelationColumn({ name: "vehicle_id", nullable: true })
  vehicle!: Relation<JcrVehicle> | null;
  @OneToOne(() => JcrVehicle)
  @RelationColumn({ name: "spare_id", nullable: true })
  spare!: Relation<JcrVehicle> | null;
}

@Entity({ name: "jcr_garages" })
class JcrGarage {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) city!: string;
  @ManyToMany(() => JcrVehicle, {
    joinTable: { name: "jcr_garage_vehicles", joinColumn: "garage_id", inverseJoinColumn: "vehicle_id" },
  })
  vehicles!: JcrVehicle[];
}

describe("[Integration] SQLite: relations targeting a JOINED child", () => {
  let em: EntityManager;
  let alice: JcrOwner;
  let bob: JcrOwner;
  let truck: JcrVehicle;
  let van: JcrVehicle;
  let tripId: number;
  let garageId: number;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [JcrOwner, JcrAsset, JcrVehicle, JcrTrip, JcrGarage],
      connectionName: "jcr",
    });
    alice = await em.save(JcrOwner, { name: "alice" });
    bob = await em.save(JcrOwner, { name: "bob" });
    truck = await em.save(JcrVehicle, { label: "truck", wheels: 6, owner: alice, driver: bob, keeper: bob } as any);
    van = await em.save(JcrVehicle, { label: "van", wheels: 4, owner: alice, driver: alice } as any);
    const gone = await em.save(JcrVehicle, { label: "gone", wheels: 2, owner: alice } as any);
    await em.softDelete(JcrVehicle, { id: gone.id });
    const trip = await em.save(JcrTrip, { dest: "coast", vehicle: truck, spare: van } as any);
    tripId = trip.id;
    const garage = await em.save(JcrGarage, { city: "seoul" });
    garageId = garage.id;
    await em.query(
      `INSERT INTO jcr_garage_vehicles (garage_id, vehicle_id) VALUES (${garage.id}, ${truck.id}), (${garage.id}, ${van.id})`,
    );
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("JOINs a ManyToOne and an owning OneToOne with the inherited columns", async () => {
    const trip = (await em.findOne(JcrTrip, { where: { id: tripId }, relations: ["vehicle", "spare"] }))!;
    expect(trip.vehicle).toMatchObject({ id: truck.id, label: "truck", wheels: 6 });
    expect(trip.spare).toMatchObject({ id: van.id, label: "van", wheels: 4 });
  });

  it("reads the to-one relations of a cursor page", async () => {
    const page = await em.findWithCursor(JcrTrip, { take: 5, relations: ["vehicle", "spare"] });
    expect(page.data[0].vehicle).toMatchObject({ label: "truck", wheels: 6 });
    expect(page.data[0].spare).toMatchObject({ label: "van", wheels: 4 });
  });

  it("batches a OneToMany by a join column on the root's table or on the child's", async () => {
    const owner = (await em.findOne(JcrOwner, {
      where: { id: alice.id },
      relations: { vehicles: { orderBy: { label: "ASC" } }, driven: true },
    }))!;
    // The soft-deleted vehicle is left out, as find(JcrVehicle) leaves it out.
    expect(owner.vehicles.map((v) => [v.label, v.wheels])).toEqual([["truck", 6], ["van", 4]]);
    expect(owner.driven.map((v) => v.label)).toEqual(["van"]);
  });

  it("filters, orders and pages a relation by inherited columns", async () => {
    const owner = (await em.findOne(JcrOwner, {
      where: { id: alice.id },
      relations: { vehicles: { where: { label: { startsWith: "t" } } } },
    }))!;
    expect(owner.vehicles.map((v) => v.label)).toEqual(["truck"]);

    const paged = (await em.findOne(JcrOwner, {
      where: { id: alice.id },
      relations: { vehicles: { orderBy: { label: "DESC" }, take: 1 } },
    }))!;
    expect(paged.vehicles.map((v) => v.label)).toEqual(["van"]);
  });

  it("reads a ManyToMany through its join table", async () => {
    const garage = (await em.findOne(JcrGarage, {
      where: { id: garageId },
      relations: { vehicles: { orderBy: { label: "ASC" } } },
    }))!;
    expect(garage.vehicles.map((v) => [v.label, v.wheels])).toEqual([["truck", 6], ["van", 4]]);
  });

  it("reads an inverse OneToOne", async () => {
    const owners = await em.find(JcrOwner, { relations: ["kept"], orderBy: { id: "ASC" } });
    expect(owners.find((o) => o.id === bob.id)!.kept).toMatchObject({ label: "truck", wheels: 6 });
    expect(owners.find((o) => o.id === alice.id)!.kept).toBeNull();
  });

  it("loads a nested level that reaches a JOINED child", async () => {
    const trips = await em.find(JcrTrip, { where: { id: tripId }, relations: ["vehicle.driver", "vehicle.owner"] });
    expect(trips[0].vehicle!.driver!.name).toBe("bob");
    expect(trips[0].vehicle!.owner!.name).toBe("alice");
  });
});
