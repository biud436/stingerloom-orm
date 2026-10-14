/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A custom column type registered with `em.registerColumnType()` — a
 * shorthand for `ColumnTypeRegistry.getInstance().register()` — used by an
 * entity end to end: the DDL takes the dialect's SQL type, and the type's
 * transformer converts values on the way in and out.
 */
import "reflect-metadata";
import { EntityManager } from "../../../src/core/EntityManager";
import { ColumnTypeRegistry } from "../../../src/core/ColumnTypeRegistry";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";
import { resetScannerContainer } from "../../../src/scanner/ScannerContainer";
import { DatabaseClient } from "../../../src/DatabaseClient";

interface Point {
  x: number;
  y: number;
}

describe("[Integration] SQLite: custom column type registered on the EntityManager", () => {
  const typeName = "cct_point";
  let em: EntityManager;
  let Place: any;

  beforeAll(async () => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();

    em = new EntityManager();
    em.registerColumnType(typeName, {
      mysql: "VARCHAR(64)",
      postgres: "VARCHAR(64)",
      sqlite: "TEXT",
      transformer: {
        to: (value: Point) => `${value.x},${value.y}`,
        from: (raw: string) => {
          const [x, y] = raw.split(",").map(Number);
          return { x, y };
        },
      },
    });

    @Entity({ name: "cct_place" })
    class CctPlace {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "varchar", length: 40 }) name!: string;
      @Column({ type: typeName as any }) location!: Point;
    }
    Place = CctPlace;

    await em.register({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
      logging: false,
      entities: [CctPlace],
    } as any);
  });

  afterAll(async () => {
    ColumnTypeRegistry.getInstance().unregister(typeName);
    try {
      await DatabaseClient.getInstance().close();
    } catch {
      // already closed
    }
    MetadataLayerRegistry.reset();
    resetScannerContainer();
  });

  it("is registered process-wide, not on this EntityManager alone", () => {
    expect(ColumnTypeRegistry.getInstance().has(typeName)).toBe(true);
  });

  it("creates the column with the dialect's SQL type", async () => {
    const cols = (await em.query(`PRAGMA table_info("cct_place")`)) as any[];
    expect(cols.find((c) => c.name === "location")?.type).toBe("TEXT");
  });

  it("stores the transformed value and reads it back through the transformer", async () => {
    const saved: any = await em.save(Place, { name: "home", location: { x: 3, y: 4 } });

    const raw = (await em.query(`SELECT "location" FROM "cct_place" WHERE "id" = ${saved.id}`)) as any[];
    expect(raw[0].location).toBe("3,4");

    const found: any = await em.findOne(Place, { where: { id: saved.id } });
    expect(found?.location).toEqual({ x: 3, y: 4 });
  });
});
