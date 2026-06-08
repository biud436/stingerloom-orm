/**
 * SQLite integration tests for SelectQueryBuilder.paginate().
 *
 * Verifies the query-builder offset-pagination helper end-to-end against a
 * real SQLite database:
 *  - page metadata (total / totalPages / hasNextPage / hasPreviousPage)
 *  - 1-based page math and partial last page
 *  - page/pageSize normalization (non-positive / fractional / out-of-range)
 *  - WHERE-filtered totals (count reflects the same predicate as the page)
 *  - builder immutability (paginate() does not clobber the source builder)
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { generateTableName } from "../helpers/create-test-entity";

interface WidgetShape {
  id: number;
  name: string;
  category: string;
}

describe("[Integration] SQLite In-Memory: SelectQueryBuilder.paginate()", () => {
  let conn: TestConnectionResult;
  let Widget: new () => WidgetShape;
  let tableName: string;

  beforeAll(async () => {
    tableName = generateTableName("paginate_widgets");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        const DynClass = class {} as any;
        Object.defineProperty(DynClass, "name", {
          value: tableName,
          writable: false,
        });

        Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
        PrimaryGeneratedColumn()(DynClass.prototype, "id");

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
        Column({ type: "varchar", length: 255 })(DynClass.prototype, "name");

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "category");
        Column({ type: "varchar", length: 50 })(DynClass.prototype, "category");

        Entity()(DynClass);
        Widget = DynClass;
        return { entities: [DynClass] };
      },
    );

    const { em } = conn;
    // 25 rows: ids 1..25. Even ids → "even", odd ids → "odd".
    for (let i = 1; i <= 25; i++) {
      await em.save(Widget, {
        name: `widget-${String(i).padStart(2, "0")}`,
        category: i % 2 === 0 ? "even" : "odd",
      });
    }
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("returns the first page with correct metadata", async () => {
    const result = await conn.em
      .createQueryBuilder(Widget, "w")
      .orderBy({ id: "ASC" })
      .paginate({ page: 1, pageSize: 10 });

    expect(result.data).toHaveLength(10);
    expect(result.data.map((w) => w.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.total).toBe(25);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
    expect(result.totalPages).toBe(3);
    expect(result.hasNextPage).toBe(true);
    expect(result.hasPreviousPage).toBe(false);
  });

  it("applies the correct OFFSET for a middle page", async () => {
    const result = await conn.em
      .createQueryBuilder(Widget, "w")
      .orderBy({ id: "ASC" })
      .paginate({ page: 2, pageSize: 10 });

    expect(result.data.map((w) => w.id)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(result.page).toBe(2);
    expect(result.hasNextPage).toBe(true);
    expect(result.hasPreviousPage).toBe(true);
  });

  it("returns a partial last page", async () => {
    const result = await conn.em
      .createQueryBuilder(Widget, "w")
      .orderBy({ id: "ASC" })
      .paginate({ page: 3, pageSize: 10 });

    expect(result.data.map((w) => w.id)).toEqual([21, 22, 23, 24, 25]);
    expect(result.totalPages).toBe(3);
    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(true);
  });

  it("returns an empty page beyond the last page (without erroring)", async () => {
    const result = await conn.em
      .createQueryBuilder(Widget, "w")
      .orderBy({ id: "ASC" })
      .paginate({ page: 99, pageSize: 10 });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(25);
    expect(result.page).toBe(99);
    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(true);
  });

  it("defaults to page 1 / pageSize 20 when no options are given", async () => {
    const result = await conn.em
      .createQueryBuilder(Widget, "w")
      .orderBy({ id: "ASC" })
      .paginate();

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.data).toHaveLength(20);
    expect(result.totalPages).toBe(2);
  });

  it("normalizes non-positive / fractional page numbers to 1 / floor", async () => {
    const zero = await conn.em
      .createQueryBuilder(Widget, "w")
      .orderBy({ id: "ASC" })
      .paginate({ page: 0, pageSize: 10 });
    expect(zero.page).toBe(1);
    expect(zero.data[0].id).toBe(1);

    const fractional = await conn.em
      .createQueryBuilder(Widget, "w")
      .orderBy({ id: "ASC" })
      .paginate({ page: 2.9, pageSize: 10 });
    expect(fractional.page).toBe(2);
    expect(fractional.data[0].id).toBe(11);
  });

  it("counts only rows matching the builder's WHERE predicate", async () => {
    const result = await conn.em
      .createQueryBuilder(Widget, "w")
      .where("category", "even")
      .orderBy({ id: "ASC" })
      .paginate({ page: 1, pageSize: 5 });

    // 12 even ids (2,4,...,24)
    expect(result.total).toBe(12);
    expect(result.totalPages).toBe(3);
    expect(result.data).toHaveLength(5);
    expect(result.data.every((w) => w.category === "even")).toBe(true);
    expect(result.data.map((w) => w.id)).toEqual([2, 4, 6, 8, 10]);
  });

  it("does not mutate the source builder (re-pageable / reusable)", async () => {
    const qb = conn.em
      .createQueryBuilder(Widget, "w")
      .where("category", "odd")
      .orderBy({ id: "ASC" });

    const page1 = await qb.paginate({ page: 1, pageSize: 4 });
    const page2 = await qb.paginate({ page: 2, pageSize: 4 });

    expect(page1.data.map((w) => w.id)).toEqual([1, 3, 5, 7]);
    expect(page2.data.map((w) => w.id)).toEqual([9, 11, 13, 15]);

    // Source builder still has no LIMIT applied — getMany() returns all 13 odds.
    const all = await qb.getMany();
    expect(all).toHaveLength(13);
  });

  it("paginatePartial() returns projected plain objects with page metadata", async () => {
    const result = await conn.em
      .createQueryBuilder(Widget, "w")
      .select(["id", "name"])
      .orderBy({ id: "ASC" })
      .paginatePartial({ page: 1, pageSize: 3 });

    expect(result.total).toBe(25);
    expect(result.totalPages).toBe(9);
    expect(result.data).toHaveLength(3);
    // Projected shape: id + name selected, category omitted.
    expect(result.data[0]).toEqual({ id: 1, name: "widget-01" });
    expect(result.data[0]).not.toHaveProperty("category");
  });

  it("paginatePartial() honors WHERE + page math", async () => {
    const result = await conn.em
      .createQueryBuilder(Widget, "w")
      .select(["id"])
      .where("category", "odd")
      .orderBy({ id: "DESC" })
      .paginatePartial({ page: 1, pageSize: 5 });

    // 13 odd ids (1,3,...,25)
    expect(result.total).toBe(13);
    expect(result.totalPages).toBe(3);
    expect(result.data.map((w) => w.id)).toEqual([25, 23, 21, 19, 17]);
  });
});
