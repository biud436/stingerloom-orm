/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MySQL / PostgreSQL: relations on a TABLE_PER_CLASS root.
 *
 * Mirrors the SQLite suite tpc-root-relations. What is dialect-specific
 * here: `floors`, an integer column only the third concrete table holds,
 * needs PostgreSQL's typed NULL padding — two untyped NULLs ahead of it would
 * resolve the UNION column to text — and a relation is JOINed onto the
 * derived table rather than onto a base table.
 */
import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "../helpers/driver-config";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorValue,
  ManyToOne,
  OneToMany,
  RelationColumn,
} from "../../../src";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const suffix = Date.now().toString().slice(-6);
const TABLES = {
  owner: `trd_owner_${suffix}`,
  asset: `trd_asset_${suffix}`,
  vehicle: `trd_vehicle_${suffix}`,
  building: `trd_building_${suffix}`,
};

function defineEntities() {
  @Entity({ name: TABLES.owner })
  class Owner {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
    @OneToMany(() => Asset, { mappedBy: "owner" }) assets!: any[];
  }

  @Entity({ name: TABLES.asset })
  @Inheritance({ strategy: "TABLE_PER_CLASS" })
  class Asset {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) label!: string;
    @ManyToOne(() => Owner, (o: any) => o.assets)
    @RelationColumn({ name: "owner_id" })
    owner!: Owner | null;
  }

  @Entity({ name: TABLES.vehicle })
  @DiscriminatorValue("vehicle")
  class Vehicle extends Asset {
    @Column({ type: "int", nullable: true }) wheels!: number;
    @ManyToOne(() => Owner, (o: any) => o.driven)
    @RelationColumn({ name: "driver_id" })
    driver!: Owner | null;
  }

  @Entity({ name: TABLES.building })
  @DiscriminatorValue("building")
  class Building extends Asset {
    @Column({ type: "int", nullable: true }) floors!: number;
  }

  return { Owner, Asset, Vehicle, Building };
}

type Entities = ReturnType<typeof defineEntities>;

describe.each(drivers)(
  "[Integration][$label] relations on a TABLE_PER_CLASS root",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult | undefined;
    let E: Entities;
    let em: any;
    let alice: any;
    let bob: any;

    const byLabel = (rows: any[]) =>
      [...rows].sort((a, b) => String(a.label).localeCompare(String(b.label)));
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

    const drop = (t: string) =>
      em.query(
        type === "postgres"
          ? `DROP TABLE IF EXISTS "${t}" CASCADE`
          : `DROP TABLE IF EXISTS \`${t}\``,
      );

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          E = defineEntities();
          return { entities: Object.values(E) };
        },
      );
      em = conn.em as any;
      alice = await em.save(E.Owner, { name: "alice" });
      bob = await em.save(E.Owner, { name: "bob" });
      await em.save(E.Vehicle, { label: "car", wheels: 4, owner: alice, driver: bob });
      await em.save(E.Building, { label: "house", floors: 2, owner: bob });
      await em.save(E.Asset, { label: "plot", owner: alice });
    }, 60000);

    afterAll(async () => {
      if (em) {
        for (const t of [TABLES.vehicle, TABLES.building, TABLES.asset, TABLES.owner]) {
          await drop(t);
        }
      }
      await conn?.cleanup();
    }, 60000);

    it("find() on the root loads a root relation into every subclass instance", async () => {
      const rows = byLabel(await em.find(E.Asset, { relations: ["owner"] }));

      expect(rows.map((r) => [r.constructor, r.ownerId, r.owner?.name])).toEqual([
        [E.Vehicle, alice.id, "alice"],
        [E.Building, bob.id, "bob"],
        [E.Asset, alice.id, "alice"],
      ]);
      expect(plain(rows[0])).toMatchObject({ wheels: 4, driverId: bob.id });
      expect(plain(rows[0])).not.toHaveProperty("floors");
      expect(plain(rows[1])).not.toHaveProperty("driverId");
    });

    it("filters, counts and pages the root by a root relation's key", async () => {
      const where = { ownerId: alice.id };
      expect(byLabel(await em.find(E.Asset, { where })).map((r) => r.label)).toEqual([
        "car",
        "plot",
      ]);
      expect(await em.count(E.Asset, where)).toBe(2);

      const page = await em.findWithCursor(E.Asset, { take: 10, where, relations: ["owner"] });
      expect(page.data.map((r: any) => r.owner?.name)).toEqual(["alice", "alice"]);
    });

    it("loads a OneToMany targeting the root from every concrete table", async () => {
      const owners = await em.find(E.Owner, { relations: ["assets"], orderBy: { id: "ASC" } });

      expect(
        owners.map((o: any) => byLabel(o.assets).map((a) => `${a.constructor.name}:${a.label}`)),
      ).toEqual([["Vehicle:car", "Asset:plot"], ["Building:house"]]);
    });
  },
);
