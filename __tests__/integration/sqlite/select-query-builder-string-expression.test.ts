/**
 * SQLite integration test: string expressions in groupBy() / addOrderBy() /
 * addSelect() / window partitionBy() run against a real database.
 *
 * Before this fix `groupBy(["UPPER(grp_code)"])` was quoted whole as one
 * identifier — `"r"."UPPER(grp_code)"` — and failed with
 * `no such column: r.UPPER(grp_code)`; only selectRaw() told a bare column
 * reference apart from an expression. The rule is now shared, and this file
 * pins what it means at the SQL level:
 *
 *  - a bare `prop` / `alias.prop` string is a column reference and goes
 *    through the property → column map (`grp` → `grp_code`);
 *  - an expression string is emitted verbatim, so it names DB columns and is
 *    not NamingStrategy-mapped — the QueryDSL form (`r.grp.toUpperCase()`)
 *    is the portable alternative;
 *  - a bare SELECT-list alias is still a column reference; a `sql` fragment
 *    is the route for grouping by an alias.
 *
 * Driver errors are captured with try/catch rather than `rejects.toThrow`:
 * better-sqlite3's error class is process-global and trips jest's
 * instanceof check when the file runs late in a single worker.
 *
 * Guarded like its siblings: only runs under INTEGRATION_TEST=true.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { qAlias } from "../../../src/core/SelectQueryBuilder";
import { rowNumber } from "../../../src/core/expressions/WindowFunctions";
import { OrmError } from "../../../src/errors/OrmError";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { sql } from "../../../src/utils/sqlTag";

const suffix = String(Date.now()).slice(-6);

describe("[Integration] SQLite In-Memory: string expressions in groupBy / addOrderBy / addSelect / partitionBy", () => {
  let conn: TestConnectionResult;
  type SxRow = { id: number; grp: string; val: number };
  let Row: new () => SxRow;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        @Entity({ name: `sx_rows_${suffix}` })
        class SxRowEntity {
          @PrimaryGeneratedColumn() id!: number;
          // Custom DB name so the bare-reference path (grp → grp_code) is
          // observable and distinct from the verbatim expression path.
          @Column({ type: "varchar", length: 10, name: "grp_code" })
          grp!: string;
          @Column({ type: "int" }) val!: number;
        }
        Row = SxRowEntity as unknown as new () => SxRow;
        return { entities: [SxRowEntity] };
      },
    );

    // 5 rows; case-folded there are 3 groups: A x2 (val 1,2), B x2 (3,4),
    // C x1 (5). Raw (case-sensitive) there are 5 groups.
    await conn.em.insertMany(Row, [
      { grp: "a", val: 1 },
      { grp: "A", val: 2 },
      { grp: "b", val: 3 },
      { grp: "B", val: 4 },
      { grp: "c", val: 5 },
    ] as any);
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  const qb = () => conn.em.createQueryBuilder(Row, "r");

  it("groups by a function-call expression string (was: no such column r.UPPER(grp_code))", async () => {
    const rows = await qb()
      .selectRaw(["UPPER(grp_code) AS ug", "COUNT(*) AS cnt"])
      .groupBy(["UPPER(grp_code)"])
      .addOrderBy("UPPER(grp_code)", "ASC")
      .getRawMany();
    expect(rows.map((r: any) => [r.ug, Number(r.cnt)])).toEqual([
      ["A", 2],
      ["B", 2],
      ["C", 1],
    ]);
  });

  it("groups by an arithmetic expression string", async () => {
    const rows = await qb()
      .selectRaw(["val % 2 AS parity", "COUNT(*) AS cnt"])
      .groupBy(["val % 2"])
      .addOrderBy("val % 2", "ASC")
      .getRawMany();
    expect(rows.map((r: any) => [Number(r.parity), Number(r.cnt)])).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it("getCount() over an expression group counts the groups", async () => {
    const count = await qb().groupBy(["UPPER(grp_code)"]).getCount();
    expect(count).toBe(3);
  });

  it("orders by an expression string with a direction", async () => {
    const rows = await qb()
      .addOrderBy("val % 2", "DESC")
      .addOrderBy("val", "ASC")
      .getMany();
    expect(rows.map((r) => r.val)).toEqual([1, 3, 5, 2, 4]);
  });

  it("addSelect() emits an expression string verbatim under its alias", async () => {
    const rows = await qb()
      .selectRaw(["UPPER(grp_code) AS ug"])
      .addSelect("COUNT(*)", "cnt")
      .groupBy(["UPPER(grp_code)"])
      .addOrderBy("UPPER(grp_code)", "ASC")
      .getRawMany();
    expect(rows.map((r: any) => [r.ug, Number(r.cnt)])).toEqual([
      ["A", 2],
      ["B", 2],
      ["C", 1],
    ]);
  });

  it("window partitionBy() accepts an expression string", async () => {
    const r = qAlias(Row, "r");
    const rows = await qb()
      .select([
        r.val.as("val"),
        rowNumber()
          .partitionBy("UPPER(grp_code)")
          .orderBy(r.val.desc())
          .as("rn"),
      ])
      .addOrderBy("val", "ASC")
      .getRawMany();
    // Within each case-folded group the highest val gets rn = 1.
    expect(rows.map((x: any) => [Number(x.val), Number(x.rn)])).toEqual([
      [1, 2],
      [2, 1],
      [3, 2],
      [4, 1],
      [5, 1],
    ]);
  });

  it("a bare reference still goes through the property → column map", async () => {
    const r = qAlias(Row, "r");
    const rows = await qb()
      .select([r.grp.as("g"), r.id.count().as("cnt")])
      .groupBy(["grp"])
      .addOrderBy("grp", "ASC")
      .getRawMany();
    // `grp` resolves to "r"."grp_code": 5 case-sensitive groups, BINARY order.
    expect(rows.map((x: any) => [x.g, Number(x.cnt)])).toEqual([
      ["A", 1],
      ["B", 1],
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]);
  });

  it("an expression string is verbatim SQL: property names inside it are not mapped", async () => {
    let message = "";
    try {
      await qb()
        .selectRaw(["COUNT(*) AS cnt"])
        .groupBy(["UPPER(grp)"])
        .getRawMany();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/no such column/);
    expect(message).toContain("grp");

    // The QueryDSL form resolves the property and stays dialect-portable.
    const r = qAlias(Row, "r");
    const upper = r.grp.toUpperCase();
    const rows = await qb()
      .select([upper.as("ug"), r.id.count().as("cnt")])
      .groupBy([upper])
      .addOrderBy(upper, "ASC")
      .getRawMany();
    expect(rows.map((x: any) => [x.ug, Number(x.cnt)])).toEqual([
      ["A", 2],
      ["B", 2],
      ["C", 1],
    ]);
  });

  it("a bare SELECT-list alias is a column reference; a sql fragment groups by the alias", async () => {
    let message = "";
    try {
      await qb()
        .selectRaw(["UPPER(grp_code) AS ug", "COUNT(*) AS cnt"])
        .groupBy(["ug"])
        .getRawMany();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/no such column/);
    expect(message).toContain("ug");

    const rows = await qb()
      .selectRaw(["UPPER(grp_code) AS ug", "COUNT(*) AS cnt"])
      .groupBy([sql`ug`])
      .getRawMany();
    const sorted = rows
      .map((x: any) => [x.ug, Number(x.cnt)] as [string, number])
      .sort((a, b) => a[0].localeCompare(b[0]));
    expect(sorted).toEqual([
      ["A", 2],
      ["B", 2],
      ["C", 1],
    ]);
  });

  it("an empty string entry is rejected before any SQL runs", () => {
    let caught: unknown;
    try {
      qb().groupBy([""]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OrmError);
    expect((caught as OrmError).code).toBe(OrmErrorCode.INVALID_QUERY);
    expect(() => qb().addOrderBy("   ", "ASC")).toThrow(
      /addOrderBy: empty string entry/,
    );
  });
});
