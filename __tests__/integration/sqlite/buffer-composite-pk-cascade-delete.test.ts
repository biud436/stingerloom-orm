/**
 * SQLite In-Memory: WriteBuffer cascade delete under a composite-PK parent.
 *
 * Regression for the audited defect: the buffer's
 * `CascadeProcessor.collectCascadeDeletes` built the child criteria only when
 * the parent had exactly ONE primary-key column (`parentPks.length === 1`), so
 * a composite-PK parent silently skipped cascade collection. The DB rows were
 * (redundantly) still removed by the CORE cascade running inside the parent's
 * `txEm.delete`, but because the buffer queued no child DELETE entries, the
 * per-delete identity-map eviction never ran for the children — a later PK
 * findOne() served the deleted child row from the first-level cache (ghost
 * read). The stale-cache test below is the one that reproduced the defect;
 * the row-deletion tests act as guards for the buffer's own delete path.
 *
 * The fix resolves the parent column the child FK references — the inverse
 * @ManyToOne's `references` option when set, else the parent's FIRST PK column
 * (mirroring core CascadeHandler.cascadeDeleteOneToMany) — and cascades through
 * it regardless of how many PK columns the parent has.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryColumn,
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
  ManyToManyScanner,
  OneToOneScanner,
} from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: WriteBuffer composite-PK parent cascade delete", () => {
  let conn: TestConnectionResult;
  // Composite PK (id, region)
  let Shipment: new () => any;
  let Parcel: new () => any;

  const shipmentName = shortName("cpkship");
  const parcelName = shortName("cpkparcel");

  beforeAll(async () => {
    // SQLite cannot ALTER TABLE ADD FOREIGN KEY, so synchronize is off and
    // the tables are created by hand.
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
        getScannerInstance(ManyToManyScanner).clear();
        getScannerInstance(OneToOneScanner).clear();

        // ── Shipment (composite PK: id + region, O2M → Parcel, cascade) ──
        const ShipC = class {} as any;
        Object.defineProperty(ShipC, "name", { value: shipmentName });
        Reflect.defineMetadata("design:type", Number, ShipC.prototype, "id");
        PrimaryColumn({ type: "int" })(ShipC.prototype, "id");
        Reflect.defineMetadata("design:type", String, ShipC.prototype, "region");
        PrimaryColumn({ type: "varchar", length: 8 })(ShipC.prototype, "region");
        Reflect.defineMetadata("design:type", String, ShipC.prototype, "label");
        Column()(ShipC.prototype, "label");
        Reflect.defineMetadata("design:type", Array, ShipC.prototype, "parcels");

        // ── Parcel (M2O → Shipment via backing @Column shipmentId) ──
        const ParcelC = class {} as any;
        Object.defineProperty(ParcelC, "name", { value: parcelName });
        Reflect.defineMetadata("design:type", Number, ParcelC.prototype, "id");
        PrimaryGeneratedColumn()(ParcelC.prototype, "id");
        Reflect.defineMetadata("design:type", String, ParcelC.prototype, "title");
        Column()(ParcelC.prototype, "title");
        Reflect.defineMetadata("design:type", Number, ParcelC.prototype, "shipmentId");
        Column({ type: "int", nullable: true })(ParcelC.prototype, "shipmentId");
        Reflect.defineMetadata("design:type", ShipC, ParcelC.prototype, "shipment");
        ManyToOne(
          () => ShipC,
          (s: any) => s.parcels,
        )(ParcelC.prototype, "shipment");
        Entity()(ParcelC);
        Parcel = ParcelC;

        OneToMany(() => ParcelC, {
          mappedBy: "shipment",
          cascade: true,
        })(ShipC.prototype, "parcels");
        Entity()(ShipC);
        Shipment = ShipC;

        return { entities: [ShipC, ParcelC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${shipmentName}" ("id" INTEGER NOT NULL, "region" TEXT NOT NULL, "label" TEXT, PRIMARY KEY ("id", "region"))`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${parcelName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT, "shipmentId" INTEGER)`,
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${parcelName}"`);
    await connector.query(`DELETE FROM "${shipmentName}"`);
  });

  async function seedShipment(id: number, region: string, parcelTitles: string[]): Promise<void> {
    const seedBuf: WriteBuffer = (conn.em as any).buffer();
    seedBuf.persist(Object.assign(new Shipment(), { id, region, label: `${id}-${region}` }));
    await seedBuf.flush();
    for (const title of parcelTitles) {
      await conn.em.save(Parcel, { title, shipmentId: id } as any);
    }
  }

  it("cascade delete of a composite-PK parent also deletes its children", async () => {
    await seedShipment(1, "kr", ["p1", "p2"]);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const parent = await buf.findOne(Shipment, {
      where: { id: 1, region: "kr" } as any,
    });
    expect(parent).not.toBeNull();

    buf.remove(parent);
    await buf.flush();

    const parcels = await conn.em.find(Parcel);
    expect(parcels).toHaveLength(0);
    const shipments = await conn.em.find(Shipment);
    expect(shipments).toHaveLength(0);
  });

  it("evicts tracked children of the deleted composite-PK parent from the identity map", async () => {
    await seedShipment(1, "kr", ["p1", "p2"]);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const parent = await buf.findOne(Shipment, {
      where: { id: 1, region: "kr" } as any,
    });
    const children = await buf.find(Parcel, {});
    expect(children).toHaveLength(2);

    buf.remove(parent);
    await buf.flush();

    // The child row is gone from the DB — the identity map must not serve it.
    const ghost = await buf.findOne(Parcel, {
      where: { id: (children[0] as any).id } as any,
    });
    expect(ghost).toBeNull();
  });

  it("only deletes the children of the removed parent (criteria stays scoped)", async () => {
    await seedShipment(1, "kr", ["p1", "p2"]);
    await seedShipment(2, "kr", ["p3"]);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const parent = await buf.findOne(Shipment, {
      where: { id: 1, region: "kr" } as any,
    });
    buf.remove(parent);
    await buf.flush();

    const parcels = await conn.em.find(Parcel);
    expect(parcels).toHaveLength(1);
    expect((parcels[0] as any).title).toBe("p3");
    const shipments = await conn.em.find(Shipment);
    expect(shipments).toHaveLength(1);
    expect((shipments[0] as any).id).toBe(2);
  });
});
