/**
 * SQLite In-Memory: WriteBuffer persist() with an application-assigned PK.
 *
 * Regression for the audited data-loss bug: buffer.persist() classified any
 * instance that already carries a PK value as MANAGED (delegating to track()),
 * on the assumption that a present PK means the row was loaded from the DB.
 *
 * That assumption only holds for DB-generated PKs (auto-increment / uuid), which
 * are undefined on a freshly-constructed entity. For an APPLICATION-ASSIGNED PK
 * (@PrimaryColumn — natural key, or a pre-set uuid) the value is always present
 * on a brand-new entity, so persist() tracked it as already-managed and NEVER
 * emitted an INSERT. flush() reported success while the row silently vanished.
 *
 * The fix: an assigned-PK instance that is not yet known to the buffer (not
 * tracked, no prior MANAGED state) is a NEW entity → queue the INSERT. A DB-
 * generated PK keeps the original track()-on-present-PK behavior.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryColumn } from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: WriteBuffer persist() with assigned PK", () => {
  let conn: TestConnectionResult;
  // Natural-key entity: PK "code" is supplied by the application.
  let Country: new () => any;

  beforeAll(async () => {
    const className = shortName("Country");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        const CC = class {} as any;
        Object.defineProperty(CC, "name", { value: className });
        Reflect.defineMetadata("design:type", String, CC.prototype, "code");
        PrimaryColumn({ type: "varchar", length: 8 })(CC.prototype, "code");
        Reflect.defineMetadata("design:type", String, CC.prototype, "name");
        Column()(CC.prototype, "name");
        Entity()(CC);

        Country = CC;
        return { entities: [CC] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    await conn.em.clear(Country);
  });

  it("persist() of a brand-new assigned-PK entity INSERTs the row on flush", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const kr = Object.assign(new Country(), { code: "KR", name: "Korea" });
    buf.persist(kr);

    // It must be scheduled as an INSERT, not silently treated as managed.
    expect(buf.size().persists).toBe(1);
    expect(buf.tracked()).toHaveLength(0);

    await buf.flush();

    // The row must actually exist in the database.
    const row = await conn.em.findOne(Country, { where: { code: "KR" } as any });
    expect(row).not.toBeNull();
    expect((row as any).name).toBe("Korea");
  });

  it("persist() of several assigned-PK entities INSERTs all of them", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    buf.persist(Object.assign(new Country(), { code: "US", name: "United States" }));
    buf.persist(Object.assign(new Country(), { code: "JP", name: "Japan" }));

    expect(buf.size().persists).toBe(2);

    await buf.flush();

    const rows = await conn.em.find(Country);
    const codes = rows.map((r: any) => r.code).sort();
    expect(codes).toEqual(["JP", "US"]);
  });

  it("re-persist after flush is idempotent (no duplicate INSERT)", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const fr = Object.assign(new Country(), { code: "FR", name: "France" });
    buf.persist(fr);
    await buf.flush();

    // Same instance, now flushed → should be MANAGED, re-persist is a no-op.
    buf.persist(fr);
    expect(buf.size().persists).toBe(0);

    // Second flush must not attempt another INSERT of the same PK.
    await expect(buf.flush()).resolves.toBeDefined();

    const rows = await conn.em.find(Country);
    expect(rows).toHaveLength(1);
  });

  it("persist() of an already-tracked assigned-PK entity does not re-INSERT", async () => {
    // Seed a row and load it through the buffer (auto-tracked / MANAGED).
    await conn.em.save(Country, { code: "DE", name: "Germany" } as any);
    const buf: WriteBuffer = (conn.em as any).buffer();

    const loaded = await buf.findOne(Country, { where: { code: "DE" } as any });
    expect(loaded).not.toBeNull();

    // persist() on the loaded (managed) instance must NOT queue an INSERT.
    buf.persist(loaded);
    expect(buf.size().persists).toBe(0);

    await buf.flush();

    const rows = await conn.em.find(Country);
    expect(rows).toHaveLength(1);
  });
});
