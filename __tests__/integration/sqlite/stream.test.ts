/**
 * SQLite In-Memory: stream() / streamBatch() contract (V4-T1-2 ③).
 *
 * The streaming pair had zero integration coverage — no test anywhere ran the
 * AsyncGenerator against a real table. Beyond pinning the basic contract
 * (every row, in order, exactly once, correct window sizes), this suite is
 * the fail-before evidence for the window defect:
 *
 * The internal LIMIT/OFFSET batching overwrote a caller's own
 * `limit`/`skip` (silently streaming the whole table), while `take` leaked
 * through into every batch's LIMIT with the offset still advancing by
 * `batchSize` — so `take` larger than the batch size re-yielded overlapping
 * rows (take: 150 with batches of 100 produced 300 yields, 50 of them
 * duplicates). The caller's options now define the overall window and
 * batching happens inside it, with find()'s precedence rules.
 *
 * The SelectQueryBuilder variant had the same overwrite: a `.limit()` /
 * `.offset()` set on the builder was discarded by `.stream()`.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

const TOTAL_ROWS = 250;

describe("[Integration] SQLite: stream() / streamBatch()", () => {
  let conn: TestConnectionResult;
  let Item: any;
  const table = `stream_${String(Date.now()).slice(-6)}`;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        MetadataLayerRegistry.reset();
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: table })
        class ItemEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int" }) seq!: number;
        }

        Item = ItemEntity;
        return { entities: [ItemEntity] };
      },
    );

    await conn.em.insertMany(
      Item,
      Array.from({ length: TOTAL_ROWS }, (_, i) => ({ seq: i + 1 })),
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  it("yields every row exactly once, in order, across batch boundaries", async () => {
    const seqs: number[] = [];
    for await (const row of conn.em.stream(Item, { orderBy: { seq: "ASC" } }, 100)) {
      seqs.push((row as any).seq);
    }

    expect(seqs).toHaveLength(TOTAL_ROWS);
    expect(seqs).toEqual(Array.from({ length: TOTAL_ROWS }, (_, i) => i + 1));
  });

  it("streamBatch yields full windows and a correctly-sized tail", async () => {
    const sizes: number[] = [];
    const seqs: number[] = [];
    for await (const batch of conn.em.streamBatch(Item, { orderBy: { seq: "ASC" } }, 100)) {
      sizes.push(batch.length);
      for (const row of batch) seqs.push((row as any).seq);
    }

    expect(sizes).toEqual([100, 100, 50]);
    expect(seqs).toEqual(Array.from({ length: TOTAL_ROWS }, (_, i) => i + 1));
  });

  it("take larger than the batch size streams exactly take rows (fail-before: overlapping re-yields)", async () => {
    const seqs: number[] = [];
    for await (const row of conn.em.stream(
      Item,
      { orderBy: { seq: "ASC" }, take: 150 },
      100,
    )) {
      seqs.push((row as any).seq);
    }

    // Before the fix: 300 yields — batches of LIMIT 150 with the offset
    // advancing by 100, so seq 101..150 appeared twice.
    expect(seqs).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
  });

  it("a limit tuple defines the stream's window (fail-before: whole table)", async () => {
    const seqs: number[] = [];
    for await (const row of conn.em.stream(
      Item,
      { orderBy: { seq: "ASC" }, limit: [50, 120] },
      100,
    )) {
      seqs.push((row as any).seq);
    }

    expect(seqs).toEqual(Array.from({ length: 120 }, (_, i) => i + 51));
  });

  it("skip + take pagination windows the stream (fail-before: whole table)", async () => {
    const seqs: number[] = [];
    for await (const row of conn.em.stream(
      Item,
      { orderBy: { seq: "ASC" }, skip: 30, take: 40 },
      25,
    )) {
      seqs.push((row as any).seq);
    }

    expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => i + 31));
  });

  it("breaking out mid-stream leaves the manager fully usable", async () => {
    let yielded = 0;
    for await (const _row of conn.em.stream(Item, { orderBy: { seq: "ASC" } }, 50)) {
      if (++yielded === 42) break;
    }
    expect(yielded).toBe(42);

    // Each batch is an independent find with its own session, so an
    // abandoned generator must not hold anything open.
    await expect(conn.em.count(Item)).resolves.toBe(TOTAL_ROWS);
  });

  it("SelectQueryBuilder.stream honors a limit()/offset() window (fail-before: whole table)", async () => {
    const seqs: number[] = [];
    const stream = conn.em
      .createQueryBuilder(Item, "i")
      .orderBy({ seq: "ASC" })
      .offset(20)
      .limit(60)
      .stream(25);

    for await (const row of stream) {
      seqs.push((row as any).seq);
    }

    expect(seqs).toEqual(Array.from({ length: 60 }, (_, i) => i + 21));
  });

  it("SelectQueryBuilder.streamBatch windows inside the builder's limit", async () => {
    const sizes: number[] = [];
    const gen = conn.em
      .createQueryBuilder(Item, "i")
      .orderBy({ seq: "ASC" })
      .limit(60)
      .streamBatch(25);

    for await (const batch of gen) {
      sizes.push(batch.length);
    }

    expect(sizes).toEqual([25, 25, 10]);
  });
});
