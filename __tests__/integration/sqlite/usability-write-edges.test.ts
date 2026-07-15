/**
 * SQLite In-Memory: increment/decrement edge arguments and batchUpsert
 * heterogeneous rows (issue #404).
 *
 * Backfills __tests__/unit/increment-decrement.test.ts and upsert.test.ts,
 * which assert only generated-SQL substrings / flattened parameter arrays
 * against a mocked session:
 *
 *  - A negative or fractional `by`, and a WHERE matching zero rows, were
 *    verified nowhere against a real database (unit + integration only used
 *    positive integers). Sign flips, integer truncation, or a wrong
 *    affected count would pass silently.
 *  - batchUpsert's null fallback for a missing optional column was asserted
 *    only as "the flattened params contain null" — per-row/per-column
 *    alignment of the multi-row VALUES was never executed, so a misaligned
 *    NULL (landing in the wrong row or column) would pass silently.
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
  PrimaryColumn,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: increment/decrement edges + batchUpsert null alignment", () => {
  let conn: TestConnectionResult;
  let Counter: any;
  let Sku: any;
  const counterTable = `uwe_counter_${String(Date.now()).slice(-6)}`;
  const skuTable = `uwe_sku_${String(Date.now()).slice(-6)}`;

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

        @Entity({ name: counterTable })
        class CounterEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "float" }) score!: number;
        }

        @Entity({ name: skuTable })
        class SkuEntity {
          @PrimaryColumn({ type: "varchar", length: 32 }) sku!: string;
          @Column() name!: string;
          @Column({ type: "varchar", nullable: true }) note!: string | null;
        }

        Counter = CounterEntity;
        Sku = SkuEntity;
        return { entities: [CounterEntity, SkuEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    await conn.em.query(`DELETE FROM "${counterTable}"`);
    await conn.em.query(`DELETE FROM "${skuTable}"`);
  });

  async function scoreOf(id: number): Promise<number> {
    const rows = (await conn.em.query(
      `SELECT "score" FROM "${counterTable}" WHERE "id" = ?`,
      [id],
    )) as any[];
    return rows[0].score;
  }

  it("increment() with a negative `by` subtracts (sign is preserved end-to-end)", async () => {
    const c: any = await conn.em.save(Counter, { score: 10 } as any);

    const result = await conn.em.increment(Counter, { id: c.id } as any, "score", -3);
    expect(result.affected).toBe(1);
    expect(await scoreOf(c.id)).toBe(7);
  });

  it("decrement() with a negative `by` adds (double negation)", async () => {
    const c: any = await conn.em.save(Counter, { score: 10 } as any);

    await conn.em.decrement(Counter, { id: c.id } as any, "score", -4);
    expect(await scoreOf(c.id)).toBe(14);
  });

  it("increment() with a fractional `by` applies the exact delta", async () => {
    const c: any = await conn.em.save(Counter, { score: 1 } as any);

    await conn.em.increment(Counter, { id: c.id } as any, "score", 0.5);
    expect(await scoreOf(c.id)).toBeCloseTo(1.5, 10);
  });

  it("increment() matching zero rows reports affected: 0 and writes nothing", async () => {
    const c: any = await conn.em.save(Counter, { score: 5 } as any);

    const result = await conn.em.increment(
      Counter,
      { id: c.id + 999 } as any,
      "score",
      1,
    );
    expect(result.affected).toBe(0);
    expect(await scoreOf(c.id)).toBe(5);
  });

  it("batchUpsert() aligns a missing optional column as NULL in the RIGHT row", async () => {
    const result = await conn.em.batchUpsert(Sku, [
      { sku: "a", name: "Alpha", note: "has-note" },
      { sku: "b", name: "Beta" }, // note omitted → NULL for THIS row only
      { sku: "c", name: "Gamma", note: "also-note" },
    ] as any);
    expect(result.affected).toBeGreaterThanOrEqual(3);

    const rows = (await conn.em.query(
      `SELECT "sku", "name", "note" FROM "${skuTable}" ORDER BY "sku"`,
    )) as any[];
    expect(rows).toEqual([
      { sku: "a", name: "Alpha", note: "has-note" },
      { sku: "b", name: "Beta", note: null },
      { sku: "c", name: "Gamma", note: "also-note" },
    ]);
  });

  it("batchUpsert() with heterogeneous rows keeps alignment on the conflict-update path", async () => {
    await conn.em.batchUpsert(Sku, [
      { sku: "a", name: "Alpha", note: "old" },
      { sku: "b", name: "Beta", note: "keep-me" },
    ] as any);

    // Re-upsert: row a updates note, row b omits note (→ NULL overwrite),
    // row d is a fresh insert without note.
    await conn.em.batchUpsert(Sku, [
      { sku: "a", name: "Alpha2", note: "new" },
      { sku: "b", name: "Beta2" },
      { sku: "d", name: "Delta" },
    ] as any);

    const rows = (await conn.em.query(
      `SELECT "sku", "name", "note" FROM "${skuTable}" ORDER BY "sku"`,
    )) as any[];
    expect(rows).toEqual([
      { sku: "a", name: "Alpha2", note: "new" },
      { sku: "b", name: "Beta2", note: null },
      { sku: "d", name: "Delta", note: null },
    ]);
  });
});
