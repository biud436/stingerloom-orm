/**
 * SQLite In-Memory: WriteBuffer under SnakeNamingStrategy.
 *
 * Audited data-loss / crash defect: IdentityMapManager.getColumnInfo returns
 * `col.name` (the DB column), but after a NamingStrategy runs, `col.name` is the
 * snake_case DB name (e.g. "full_name") while the entity INSTANCE only carries
 * the camelCase property ("fullName"). The buffer then reads instance[dbName]
 * (undefined), so:
 *
 *  1. persist() silently drops every renamed column (INSERT writes NULL).
 *  2. A tracked entity's change to a renamed column is not detected (no UPDATE).
 *  3. A camelCase PK makes buildIdentityKey read instance["thing_id"] === undefined
 *     and THROW — so buffer.findOne() crashes.
 *
 * synchronize:true lets the ORM create the snake_case tables; raw SELECTs read
 * the DB columns directly to prove what was actually persisted.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../../src";
import { SnakeNamingStrategy } from "../../../src/core/generators/SnakeNamingStrategy";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: WriteBuffer under SnakeNamingStrategy", () => {
  let conn: TestConnectionResult;
  let Usr: any;
  let Thing: any;
  const usrTable = `ns_usr_${String(Date.now()).slice(-6)}`;
  const thingTable = `ns_thing_${String(Date.now()).slice(-6)}`;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        namingStrategy: new SnakeNamingStrategy(),
        plugins: [bufferPlugin()],
      },
      () => {
        MetadataLayerRegistry.reset();
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: usrTable })
        class UsrEntity {
          @PrimaryGeneratedColumn() id!: number;
          // camelCase property → snake_case column "full_name" (≠ propertyKey).
          @Column() fullName!: string;
        }

        @Entity({ name: thingTable })
        class ThingEntity {
          // camelCase PK → snake_case column "thing_id" (≠ propertyKey).
          @PrimaryGeneratedColumn() thingId!: number;
          @Column() label!: string;
        }

        Usr = UsrEntity;
        Thing = ThingEntity;
        return { entities: [UsrEntity, ThingEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  async function raw(sql: string, params: any[] = []): Promise<any[]> {
    return (await conn.em.query(sql, params)) as any[];
  }

  it("persists a renamed (snake) column on buffer INSERT", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();
    const u = new Usr();
    u.fullName = "Alice";
    buf.persist(u);
    await buf.flush();

    expect(u.id).toBeDefined();
    const rows = await raw(`SELECT "full_name" FROM "${usrTable}" WHERE "id" = ?`, [u.id]);
    expect(rows).toHaveLength(1);
    // Regression: full_name landed NULL because the buffer read instance["full_name"].
    expect(rows[0].full_name).toBe("Alice");
  });

  it("detects a change to a renamed column on a tracked entity (UPDATE)", async () => {
    const seeded: any = await conn.em.save(Usr, { fullName: "Bob" } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    const loaded: any = await buf.findOne(Usr, { where: { id: seeded.id } as any });
    expect(loaded).not.toBeNull();
    loaded.fullName = "Robert";
    const result = await buf.flush();
    expect(result.updates).toBe(1);

    const rows = await raw(`SELECT "full_name" FROM "${usrTable}" WHERE "id" = ?`, [seeded.id]);
    expect(rows[0].full_name).toBe("Robert");
  });

  it("batch UPDATE (CASE WHEN) targets the snake column, not the property key", async () => {
    const a: any = await conn.em.save(Usr, { fullName: "A" } as any);
    const b: any = await conn.em.save(Usr, { fullName: "B" } as any);

    // batchUpdate:true + 2 single-PK, non-versioned rows exercises the raw
    // CASE WHEN path (no per-row save fallback).
    const buf: WriteBuffer = (conn.em as any).buffer({ batchUpdate: true });
    const la: any = await buf.findOne(Usr, { where: { id: a.id } as any });
    const lb: any = await buf.findOne(Usr, { where: { id: b.id } as any });
    la.fullName = "AA";
    lb.fullName = "BB";
    const result = await buf.flush();
    expect(result.updates).toBe(2);

    const rows = await raw(
      `SELECT "id", "full_name" FROM "${usrTable}" WHERE "id" IN (?, ?) ORDER BY "id"`,
      [a.id, b.id],
    );
    expect(rows.map((r) => r.full_name)).toEqual(["AA", "BB"]);
  });

  it("does not throw on buffer.findOne() for an entity with a camelCase PK", async () => {
    const seeded: any = await conn.em.save(Thing, { label: "x" } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    // Regression: buildIdentityKey read instance["thing_id"] (undefined) and threw.
    const loaded: any = await buf.findOne(Thing, {
      where: { thingId: seeded.thingId } as any,
    });
    expect(loaded).not.toBeNull();
    expect(loaded.thingId).toBe(seeded.thingId);
    expect(loaded.label).toBe("x");
  });
});
