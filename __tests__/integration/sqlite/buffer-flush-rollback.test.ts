/**
 * SQLite In-Memory: WriteBuffer flush-failure state restoration.
 *
 * Regression for the audited rollback bug: flush() mutates instances in place
 * (writes back the generated PK, increments @Version, sets timestamps) as each
 * INSERT/UPDATE runs. When a LATER statement in the same flush fails, the whole
 * transaction rolls back in the DB — but those in-memory mutations were not
 * undone. The result:
 *   - a persisted instance kept a PK for a row that no longer exists (ghost),
 *   - a versioned instance kept an incremented @Version, so retrying the flush
 *     raised a spurious OptimisticLockError (WHERE version = <already-bumped>).
 *
 * The fix snapshots each mutated instance's column values before the flush
 * transaction and restores them if the transaction throws, leaving exactly the
 * pre-flush (user-edited) state so a retry behaves as if the first flush never
 * ran.
 *
 * The mid-flush failure is forced by a flush-event listener that throws — a
 * schema-independent way to abort the transaction AFTER the earlier
 * INSERT/UPDATE has already mutated its instance in memory. (An earlier draft
 * relied on a NOT NULL violation, but the constraint's enforcement proved
 * fragile across the shared-singleton integration environment.)
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
  Version,
} from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: WriteBuffer flush-failure state restoration", () => {
  let conn: TestConnectionResult;
  let Item: new () => any;
  let Doc: new () => any;

  beforeAll(async () => {
    const itemName = shortName("RbItem");
    const docName = shortName("RbDoc");

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

        const IC = class {} as any;
        Object.defineProperty(IC, "name", { value: itemName });
        Reflect.defineMetadata("design:type", Number, IC.prototype, "id");
        PrimaryGeneratedColumn()(IC.prototype, "id");
        Reflect.defineMetadata("design:type", String, IC.prototype, "name");
        Column()(IC.prototype, "name");
        Entity()(IC);
        Item = IC;

        const DC = class {} as any;
        Object.defineProperty(DC, "name", { value: docName });
        Reflect.defineMetadata("design:type", Number, DC.prototype, "id");
        PrimaryGeneratedColumn()(DC.prototype, "id");
        Reflect.defineMetadata("design:type", String, DC.prototype, "title");
        Column()(DC.prototype, "title");
        Reflect.defineMetadata("design:type", Number, DC.prototype, "version");
        Version()(DC.prototype, "version");
        Entity()(DC);
        Doc = DC;

        return { entities: [IC, DC] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    await conn.em.clear(Item);
    await conn.em.clear(Doc);
  });

  it("does not leave a ghost PK on a persisted instance when flush fails", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const good = new Item();
    good.name = "good";
    const bad = new Item();
    bad.name = "bad";

    buf.persist(good);
    buf.persist(bad);

    // Abort the transaction at `bad`'s INSERT — AFTER `good` was inserted and
    // its PK written back in memory. Schema-independent.
    let failNext = true;
    buf.onFlushEvent("preInsert", (e: any) => {
      if (failNext && e.instance === bad) throw new Error("boom");
    });

    await expect(buf.flush()).rejects.toThrow("boom");

    // The whole transaction rolled back — `good` must NOT keep a PK for a row
    // that no longer exists.
    expect(good.id).toBeUndefined();

    // Nothing was actually committed.
    const rows = await conn.em.find(Item);
    expect(rows).toHaveLength(0);

    // Retry (disarmed) succeeds and inserts exactly two rows.
    failNext = false;
    const result = await buf.flush();
    expect(result.inserts).toBe(2);
    const after = await conn.em.find(Item);
    expect(after).toHaveLength(2);
    expect(good.id).toBeDefined();
  });

  it("does not leave an incremented @Version when flush fails, so retry does not raise a false lock error", async () => {
    // Seed a versioned row (version = 1).
    const seeded = await conn.em.save(Doc, { title: "v1" } as any);
    expect(seeded.version).toBe(1);

    const buf: WriteBuffer = (conn.em as any).buffer();

    // Track + dirty the seeded doc (its UPDATE will bump version 1 → 2).
    const doc = await buf.findOne(Doc, { where: { id: seeded.id } as any });
    (doc as any).title = "v2";

    // Abort the transaction right after the doc's UPDATE — postUpdate fires
    // once @Version has already been bumped in memory, so we can prove the
    // rollback restores it.
    let failNext = true;
    buf.onFlushEvent("postUpdate", () => {
      if (failNext) throw new Error("boom");
    });

    await expect(buf.flush()).rejects.toThrow("boom");

    // In-memory version must be restored to 1 (rollback undid the DB bump).
    expect((doc as any).version).toBe(1);

    // Retry (disarmed) must succeed — a lingering version=2 would make the
    // UPDATE's WHERE version=? miss and raise a spurious OptimisticLockError.
    failNext = false;
    await expect(buf.flush()).resolves.toBeDefined();

    const reloaded = await conn.em.findOne(Doc, { where: { id: seeded.id } as any });
    expect(reloaded!.title).toBe("v2");
    expect(reloaded!.version).toBe(2);
  });
});
