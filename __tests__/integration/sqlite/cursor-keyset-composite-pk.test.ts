/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: keyset paging over a composite primary key.
 *
 * `findWithCursor()` and `em.pipe({ keyset: true })` used the first key
 * column as the whole tiebreaker. That column repeats across rows, so every
 * row sharing the boundary value was skipped: a walk over 9 order lines
 * (3 orders × 3 lines) in pages of 2 returned 6. The keyset now carries every
 * key column.
 */
import "reflect-metadata";
import { Entity, Column, PrimaryColumn } from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../../src/core/plugin/raw-pipeline/rawPipelinePlugin";
import { encodeCursorKey } from "../../../src/core/CursorPagination";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

@Entity({ name: "ckc_line" })
class CkcLine {
  @PrimaryColumn({ type: "int", name: "order_id" }) orderId!: number;
  @PrimaryColumn({ type: "int", name: "line_no" }) lineNo!: number;
  @Column() sku!: string;
  @Column({ type: "int" }) qty!: number;
}

const ALL = ["o1l1", "o1l2", "o1l3", "o2l1", "o2l2", "o2l3", "o3l1", "o3l2", "o3l3"];

async function walk(em: EntityManager, option: Record<string, unknown>): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page: any = await em.findWithCursor(CkcLine, { ...option, take: 2, cursor } as any);
    seen.push(...page.data.map((row: CkcLine) => row.sku));
    if (!page.hasNextPage) return seen;
    cursor = page.nextCursor;
  }
  throw new Error("cursor walk did not terminate");
}

async function drain(gen: AsyncGenerator<any[]>): Promise<any[]> {
  const rows: any[] = [];
  for await (const batch of gen) rows.push(...batch);
  return rows;
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

describe("[Integration] SQLite: keyset paging over a composite primary key", () => {
  let base: EntityManager;
  let em: any;

  beforeEach(async () => {
    base = new EntityManager();
    await base.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [CkcLine],
        synchronize: true,
        logging: false,
      } as any,
      `ckc_${Math.random().toString(36).slice(2, 10)}`,
    );
    em = base.extend(rawPipelinePlugin());
    // Inserted out of key order, and qty repeats, so neither insertion order
    // nor a unique sort value hides a skipped row.
    for (const orderId of [3, 1, 2]) {
      for (const lineNo of [2, 3, 1]) {
        await em.save(CkcLine, { orderId, lineNo, sku: `o${orderId}l${lineNo}`, qty: lineNo % 2 });
      }
    }
  });

  afterEach(async () => {
    await base.propagateShutdown();
  });

  describe("findWithCursor()", () => {
    it("pages every row in key order by default", async () => {
      expect(await walk(em, {})).toEqual(ALL);
    });

    it("pages every row by the first key column, descending", async () => {
      expect(await walk(em, { orderBy: "orderId", direction: "DESC" })).toEqual([...ALL].reverse());
    });

    it("breaks ties of a non-unique order column by the whole key", async () => {
      const seen = await walk(em, { orderBy: "qty" });

      expect(seen).toEqual([
        "o1l2", "o2l2", "o3l2",
        "o1l1", "o1l3", "o2l1", "o2l3", "o3l1", "o3l3",
      ]);
    });

    it("continues from a cursor that carried only the first key column", async () => {
      // A cursor minted before the key carried every column: that one page
      // compares the first column, as it did then.
      const legacy = encodeCursorKey(1, 1);

      const page: any = await em.findWithCursor(CkcLine, { take: 3, cursor: legacy });

      expect(page.data.map((row: CkcLine) => row.sku)).toEqual(["o2l1", "o2l2", "o2l3"]);
    });

    it("rejects a cursor whose key has the wrong number of columns", async () => {
      const error = await rejection(
        em.findWithCursor(CkcLine, { cursor: encodeCursorKey(1, [1, 2, 3]) }),
      );

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain("Invalid cursor value");
    });
  });

  describe("em.pipe({ keyset: true })", () => {
    it("reads every row by the first key column", async () => {
      const rows = await drain(
        em.pipe(CkcLine, { orderBy: { orderId: "ASC" }, keyset: true, batchSize: 2 }).raw(),
      );

      expect(rows.map((row) => row.sku)).toEqual(ALL);
    });

    it("breaks ties of a non-unique order column by the whole key", async () => {
      const rows = await drain(
        em.pipe(CkcLine, {
          orderBy: { qty: "DESC" },
          keyset: true,
          // 3 puts a batch boundary between two lines of one order.
          batchSize: 3,
          select: ["sku"],
        }).raw(),
      );

      // The key breaks ties in the page's direction, descending here.
      expect(rows.map((row) => row.sku)).toEqual([
        "o3l3", "o3l1", "o2l3", "o2l1", "o1l3", "o1l1",
        "o3l2", "o2l2", "o1l2",
      ]);
    });
  });
});
