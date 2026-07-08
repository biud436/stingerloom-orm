/**
 * SQLite In-Memory: buf.delete(entity, criteria) must invalidate the Identity Map.
 *
 * Audited data-loss / stale-read defect: a criteria delete queues a DELETE but
 * never evicts the matching tracked instance from the Identity Map. After flush
 * the row is gone from the DB, yet a subsequent PK findOne() returns the stale
 * cached instance (first-level cache hit) instead of null — a phantom read of a
 * deleted row. remove(instance) untracks correctly; delete(criteria) did not.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
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

describe("[Integration] SQLite: buf.delete(criteria) Identity Map invalidation", () => {
  let conn: TestConnectionResult;
  let Item: new () => any;
  const itemName = shortName("dcitem");

  beforeAll(async () => {
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

        const ItemC = class {} as any;
        Object.defineProperty(ItemC, "name", { value: itemName });
        Reflect.defineMetadata("design:type", Number, ItemC.prototype, "id");
        PrimaryGeneratedColumn()(ItemC.prototype, "id");
        Reflect.defineMetadata("design:type", String, ItemC.prototype, "name");
        Column()(ItemC.prototype, "name");
        Entity()(ItemC);
        Item = ItemC;

        return { entities: [ItemC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${itemName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)`,
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${itemName}"`);
  });

  it("evicts a cached instance after delete(criteria) so findOne returns null", async () => {
    const seeded: any = await conn.em.save(Item, { name: "a" } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();
    // Load into the Identity Map (first-level cache) so a later PK findOne is a
    // cache-hit candidate.
    const loaded = await buf.findOne(Item, { where: { id: seeded.id } as any });
    expect(loaded).not.toBeNull();

    // Delete by criteria (not by instance), then flush.
    buf.delete(Item, { id: seeded.id });
    await buf.flush();

    // DB row is gone.
    const rows: any[] = await conn.em.query(
      `SELECT COUNT(*) AS c FROM "${itemName}" WHERE id = ?`,
      [seeded.id],
    );
    expect(Number(rows[0].c)).toBe(0);

    // The regression: this returned the stale cached instance instead of null.
    const after = await buf.findOne(Item, { where: { id: seeded.id } as any });
    expect(after).toBeNull();
  });
});
