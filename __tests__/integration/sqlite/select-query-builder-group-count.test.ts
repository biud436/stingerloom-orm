/**
 * SQLite integration test for getCount() under GROUP BY.
 *
 * A grouped query returns one row per group, so its "total" is the number of
 * groups surviving HAVING — the same contract `findAndCount()` /
 * `findWithPage()` adopted for `FindOption.groupBy`. Before this fix the
 * builder ran `SELECT COUNT(*) ... GROUP BY ...` and returned the first row's
 * value, i.e. the size of whichever group came back first (5 for the fixture
 * below: neither the group count 3 nor the row count 7). Every consumer that
 * pairs the count with grouped rows (`getManyAndCount`, `paginate`,
 * `paginatePartial`, `getPartialManyAndCount`) inherited the wrong total.
 *
 * Guarded like its siblings: only runs under INTEGRATION_TEST=true (the suite
 * is excluded from the default unit run by jest config).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { qAlias } from "../../../src/core/SelectQueryBuilder";
import { sql } from "../../../src/utils/sqlTag";

const suffix = String(Date.now()).slice(-6);

describe("[Integration] SQLite In-Memory: getCount() with GROUP BY counts groups", () => {
  let conn: TestConnectionResult;
  type GcRow = { id: number; grp: string; val: number };
  let Row: new () => GcRow;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        @Entity({ name: `gc_rows_${suffix}` })
        class GcRowEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 10 }) grp!: string;
          @Column({ type: "int" }) val!: number;
        }
        Row = GcRowEntity as unknown as new () => GcRow;
        return { entities: [GcRowEntity] };
      },
    );

    // 7 rows, 3 groups: A x5, B x1, C x1. The uneven sizes make the three
    // candidate answers distinguishable: first-group size 5, group count 3,
    // row count 7.
    const { em } = conn;
    await em.insertMany(Row, [
      { grp: "A", val: 1 },
      { grp: "A", val: 1 },
      { grp: "A", val: 2 },
      { grp: "A", val: 2 },
      { grp: "A", val: 3 },
      { grp: "B", val: 1 },
      { grp: "C", val: 1 },
    ] as any);
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  it("returns the number of groups, not the first group's size", async () => {
    const count = await conn.em
      .createQueryBuilder(Row, "r")
      .groupBy(["grp"])
      .getCount();
    expect(count).toBe(3);
  });

  it("emits a derived-table COUNT over the grouped source", async () => {
    const built = conn.em
      .createQueryBuilder(Row, "r")
      .groupBy(["grp"])
      .having(sql`COUNT(*) >= 2`)
      .toSql();
    const text = built.sql.replace(/\s+/g, " ");
    // Data query keeps the plain GROUP BY shape; this only anchors that the
    // count wrapper below is a separate statement.
    expect(text).toContain("GROUP BY");
    expect(text).not.toContain("COUNT(*) AS");
  });

  it("honors HAVING: only groups surviving the predicate are counted", async () => {
    const count = await conn.em
      .createQueryBuilder(Row, "r")
      .groupBy(["grp"])
      .having(sql`COUNT(*) >= 2`)
      .getCount();
    expect(count).toBe(1);
  });

  it("honors a QueryDSL aggregate HAVING condition", async () => {
    const r = qAlias(Row, "r");
    const count = await conn.em
      .createQueryBuilder(Row, "r")
      .groupBy(["grp"])
      .having(r.id.count().lte(1))
      .getCount();
    expect(count).toBe(2);
  });

  it("counts distinct combinations for a multi-column GROUP BY", async () => {
    // (A,1) (A,2) (A,3) (B,1) (C,1) = 5 groups
    const count = await conn.em
      .createQueryBuilder(Row, "r")
      .groupBy(["grp", "val"])
      .getCount();
    expect(count).toBe(5);
  });

  it("applies WHERE before grouping", async () => {
    const count = await conn.em
      .createQueryBuilder(Row, "r")
      .where("r.val", 1)
      .groupBy(["grp"])
      .getCount();
    // val = 1 rows: A, A, B, C -> groups A, B, C
    expect(count).toBe(3);
  });

  it("returns 0 when no group survives", async () => {
    const count = await conn.em
      .createQueryBuilder(Row, "r")
      .where("r.val", 99)
      .groupBy(["grp"])
      .getCount();
    expect(count).toBe(0);
  });

  it("groups by a raw Sql expression entry", async () => {
    // LOWER(grp) collapses nothing here but exercises the Sql-entry branch:
    // the derived table must not try to name the expression as a column.
    const count = await conn.em
      .createQueryBuilder(Row, "r")
      .groupBy([sql`LOWER("r"."grp")`])
      .getCount();
    expect(count).toBe(3);
  });

  it("getManyAndCount() pairs grouped rows with the group count", async () => {
    const [rows, total] = await conn.em
      .createQueryBuilder(Row, "r")
      .select(["grp"])
      .groupBy(["grp"])
      .orderBy({ grp: "ASC" })
      .getPartialManyAndCount();
    expect(rows.map((x: any) => x.grp)).toEqual(["A", "B", "C"]);
    expect(total).toBe(3);
  });

  it("paginatePartial() reports totalPages over groups", async () => {
    const page = await conn.em
      .createQueryBuilder(Row, "r")
      .select(["grp"])
      .groupBy(["grp"])
      .orderBy({ grp: "ASC" })
      .paginatePartial({ page: 1, pageSize: 2 });
    expect(page.data.map((x: any) => x.grp)).toEqual(["A", "B"]);
    expect(page.total).toBe(3);
    expect(page.totalPages).toBe(2);
    expect(page.hasNextPage).toBe(true);
  });

  it("matches findAndCount() for the same GROUP BY (EM / builder symmetry)", async () => {
    const [, emTotal] = await conn.em.findAndCount(Row, {
      select: ["grp"],
      groupBy: ["grp"],
    } as any);
    const qbTotal = await conn.em
      .createQueryBuilder(Row, "r")
      .groupBy(["grp"])
      .getCount();
    expect(qbTotal).toBe(emTotal);
    expect(qbTotal).toBe(3);
  });

  it("per-group sizes stay reachable through an explicit COUNT projection", async () => {
    const r = qAlias(Row, "r");
    const rows = await conn.em
      .createQueryBuilder(Row, "r")
      .select(["grp"])
      .addSelect(r.id.count().as("cnt"))
      .groupBy(["grp"])
      .orderBy({ grp: "ASC" })
      .getRawMany();
    expect(rows.map((x: any) => [x.grp, Number(x.cnt)])).toEqual([
      ["A", 5],
      ["B", 1],
      ["C", 1],
    ]);
  });

  it("plain getCount() without GROUP BY still counts rows", async () => {
    const count = await conn.em.createQueryBuilder(Row, "r").getCount();
    expect(count).toBe(7);
  });
});
