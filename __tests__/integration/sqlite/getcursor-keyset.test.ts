/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `SelectQueryBuilder.getCursor()` pages like
 * `findWithCursor()`.
 *
 * getCursor() keyed its pages on the sort value alone, so it lost rows in
 * three ways: rows sharing the boundary value of a page were skipped, a
 * composite key was paged by its first column, and a page ending on a NULL
 * sort value produced a cursor the next call rejected as invalid. It now
 * uses the same keyset as findWithCursor(): the sort value, then every
 * primary key column, with the NULL region placed explicitly.
 */
import "reflect-metadata";
import { Entity, Column, PrimaryColumn, PrimaryGeneratedColumn } from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { encodeCursor } from "../../../src/core/CursorPagination";

@Entity({ name: "gck_item" })
class GckItem {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int", nullable: true }) age!: number | null;
  @Column() label!: string;
}

@Entity({ name: "gck_line" })
class GckLine {
  @PrimaryColumn({ type: "int", name: "order_id" }) orderId!: number;
  @PrimaryColumn({ type: "int", name: "line_no" }) lineNo!: number;
  @Column() sku!: string;
}

describe("[Integration] SQLite: getCursor() keyset", () => {
  let em: EntityManager;

  beforeEach(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [GckItem, GckLine],
        synchronize: true,
        logging: false,
      } as any,
      `gck_${Math.random().toString(36).slice(2, 10)}`,
    );
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  async function seedItems(ages: Array<number | null>): Promise<void> {
    for (let i = 0; i < ages.length; i++) {
      await em.save(GckItem, { age: ages[i], label: i % 2 === 0 ? "even" : "odd" });
    }
  }

  async function walk<E>(
    builder: () => any,
    option: Record<string, unknown>,
  ): Promise<E[]> {
    const seen: E[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await builder().getCursor({ ...option, take: 2, cursor });
      seen.push(...page.data);
      if (!page.hasNextPage) {
        expect(page.nextCursor).toBeNull();
        return seen;
      }
      cursor = page.nextCursor;
    }
    throw new Error("cursor walk did not terminate");
  }

  const items = () => em.createQueryBuilder(GckItem, "i");
  const ids = (rows: GckItem[]) => rows.map((row) => row.id);

  it("keeps rows that share the sort value of a page boundary (ASC)", async () => {
    await seedItems([10, 10, 10, 20, 20, 30]);

    const seen = await walk<GckItem>(items, { orderBy: "age" });

    expect(ids(seen)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps them descending too, the key breaking ties in the page's direction", async () => {
    await seedItems([10, 10, 10, 20, 20, 30]);

    const seen = await walk<GckItem>(items, { orderBy: "age", direction: "DESC" });

    expect(ids(seen)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("pages past NULL sort values: last ascending, first descending", async () => {
    await seedItems([null, 10, null, 20, null]);

    const asc = await walk<GckItem>(items, { orderBy: "age" });
    const desc = await walk<GckItem>(items, { orderBy: "age", direction: "DESC" });

    expect(asc.map((row) => row.age)).toEqual([10, 20, null, null, null]);
    expect(ids(asc)).toEqual([2, 4, 1, 3, 5]);
    expect(ids(desc)).toEqual([5, 3, 1, 4, 2]);
  });

  it("keeps the builder's where, and its orderBy follows the keyset keys", async () => {
    await seedItems([10, 10, 10, 10, 10, 10]);

    const seen = await walk<GckItem>(
      () => items().where("i.label", "even").orderBy({ label: "DESC" }),
      { orderBy: "age" },
    );

    expect(ids(seen)).toEqual([1, 3, 5]);
  });

  it("pages a composite key by every key column", async () => {
    for (const orderId of [3, 1, 2]) {
      for (const lineNo of [2, 3, 1]) {
        await em.save(GckLine, { orderId, lineNo, sku: `o${orderId}l${lineNo}` });
      }
    }

    const seen = await walk<GckLine>(() => em.createQueryBuilder(GckLine, "l"), {});

    expect(seen.map((row) => row.sku)).toEqual([
      "o1l1", "o1l2", "o1l3", "o2l1", "o2l2", "o2l3", "o3l1", "o3l2", "o3l3",
    ]);
  });

  it("continues from a sort-value-only cursor of an earlier version", async () => {
    await seedItems([10, 20, 30]);

    // That one page compares the sort value alone, as it did then.
    const page = await items().getCursor({ take: 5, orderBy: "age", cursor: encodeCursor(10) });

    expect(ids(page.data)).toEqual([2, 3]);
  });
});
