/**
 * SQLite In-Memory: flush lifecycle events on the opt-in BATCH paths
 * (issue #402 item 2).
 *
 * Regression: `flushPersistsBatched` / `flushUpdatesBatched` executed their
 * DML without emitting a single preInsert/postInsert/preUpdate/postUpdate
 * event — listeners registered via `onFlushEvent` fired on the default
 * per-row path but went silent the moment `batchInsert` / `batchUpdate` was
 * turned on. The batched-UPDATE fallback also skipped the per-row path's
 * @Version / @UpdateTimestamp instance sync, leaving a stale version on the
 * instance (spurious OptimisticLockError on the next flush with drivers
 * that lack RETURNING).
 *
 * On SQLite the batch INSERT multi-row SQL falls back to per-row save()
 * (by design), which is one of the two branches that must emit events; the
 * batch UPDATE CASE WHEN path executes for real.
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
import type { FlushEvent } from "../../../src/core/plugin/buffer/BufferPreview";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: WriteBuffer flush events on batch paths", () => {
  let conn: TestConnectionResult;
  let Item: any;
  let VDoc: any;
  const itemTable = `bev_item_${String(Date.now()).slice(-6)}`;
  const vdocTable = `bev_vdoc_${String(Date.now()).slice(-6)}`;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        MetadataLayerRegistry.reset();
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: itemTable })
        class ItemEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
        }

        @Entity({ name: vdocTable })
        class VDocEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() title!: string;
          @Version() version!: number;
        }

        Item = ItemEntity;
        VDoc = VDocEntity;
        return { entities: [ItemEntity, VDocEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  function recordEvents(buf: WriteBuffer): FlushEvent[] {
    const events: FlushEvent[] = [];
    for (const type of ["preInsert", "postInsert", "preUpdate", "postUpdate"] as const) {
      buf.onFlushEvent(type, (e) => {
        events.push(e);
      });
    }
    return events;
  }

  it("batchInsert emits preInsert/postInsert per persisted entity", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer({ batchInsert: true });
    const events = recordEvents(buf);

    const i1 = new Item();
    i1.name = "e1";
    const i2 = new Item();
    i2.name = "e2";
    buf.persist(i1).persist(i2);
    const result = await buf.flush();
    expect(result.inserts).toBe(2);

    const pre = events.filter((e) => e.type === "preInsert");
    const post = events.filter((e) => e.type === "postInsert");
    expect(pre).toHaveLength(2);
    expect(post).toHaveLength(2);
    expect(pre.map((e) => e.instance)).toEqual(expect.arrayContaining([i1, i2]));
    // postInsert fires AFTER the write — generated PKs must be visible.
    for (const e of post) {
      expect(e.instance.id).toBeDefined();
    }
  });

  it("batchUpdate (CASE WHEN path) emits preUpdate/postUpdate with the diff", async () => {
    const a: any = await conn.em.save(Item, { name: "u1" } as any);
    const b: any = await conn.em.save(Item, { name: "u2" } as any);

    // 2 single-PK, non-versioned rows → the real CASE WHEN batch SQL runs.
    const buf: WriteBuffer = (conn.em as any).buffer({ batchUpdate: true });
    const events = recordEvents(buf);

    const la: any = await buf.findOne(Item, { where: { id: a.id } as any });
    const lb: any = await buf.findOne(Item, { where: { id: b.id } as any });
    la.name = "u1x";
    lb.name = "u2x";
    const result = await buf.flush();
    expect(result.updates).toBe(2);

    const pre = events.filter((e) => e.type === "preUpdate");
    const post = events.filter((e) => e.type === "postUpdate");
    expect(pre).toHaveLength(2);
    expect(post).toHaveLength(2);
    for (const e of [...pre, ...post]) {
      expect(e.data).toBeDefined();
      expect(Object.keys(e.data!)).toContain("name");
    }

    const rows = (await conn.em.query(
      `SELECT "name" FROM "${itemTable}" WHERE "id" IN (?, ?) ORDER BY "id"`,
      [a.id, b.id],
    )) as any[];
    expect(rows.map((r) => r.name)).toEqual(["u1x", "u2x"]);
  });

  it("batchUpdate fallback (@Version entity) emits events and syncs the instance version", async () => {
    const s1: any = await conn.em.save(VDoc, { title: "d1" } as any);
    const s2: any = await conn.em.save(VDoc, { title: "d2" } as any);

    // @Version forces the per-row fallback inside the batched path.
    const buf: WriteBuffer = (conn.em as any).buffer({ batchUpdate: true });
    const events = recordEvents(buf);

    const l1: any = await buf.findOne(VDoc, { where: { id: s1.id } as any });
    const l2: any = await buf.findOne(VDoc, { where: { id: s2.id } as any });
    l1.title = "d1x";
    l2.title = "d2x";
    await buf.flush();

    expect(events.filter((e) => e.type === "preUpdate")).toHaveLength(2);
    expect(events.filter((e) => e.type === "postUpdate")).toHaveLength(2);
    // Parity with the per-row path: the instance's @Version reflects the
    // UPDATE the flush just wrote.
    expect(l1.version).toBe(2);
    expect(l2.version).toBe(2);

    // And the follow-up flush must not conflict on a stale version.
    l1.title = "d1y";
    await expect(buf.flush()).resolves.toBeDefined();
    expect(l1.version).toBe(3);
  });
});
