/**
 * SQLite integration test: a column whose DB name is not a plain identifier
 * (`first-name`, `2fa_enabled`, `tag label`) can be named in the builder's
 * string slots — groupBy(), addOrderBy(), selectRaw(), addSelect() and the
 * window partitionBy().
 *
 * Those slots tell a column reference from a SQL expression by shape: a
 * plain identifier, optionally `alias.`-qualified, is a column and is quoted;
 * anything else is emitted verbatim. A name like `first-name` therefore went
 * out unquoted, and the database read it as `first - name`: the query failed
 * naming a column the caller never wrote (`no such column: first`), or, when
 * both fragments were columns, became an arithmetic expression without an
 * error. A string that is exactly one of the alias's column names (or
 * property keys) is now a column reference, quoted, whatever its shape.
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

const suffix = String(Date.now()).slice(-6);

describe("[Integration] SQLite In-Memory: column names that are not plain identifiers in string slots", () => {
  let conn: TestConnectionResult;
  type QcRow = { id: number; firstName: string; twoFactor: number; amount: number };
  type QcTag = { id: number; rowId: number; label: string };
  let Row: new () => QcRow;
  let Tag: new () => QcTag;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        @Entity({ name: `qc_rows_${suffix}` })
        class QcRowEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 20, name: "first-name" })
          firstName!: string;
          @Column({ type: "int", name: "2fa_enabled" })
          twoFactor!: number;
          @Column({ type: "int" }) amount!: number;
        }
        @Entity({ name: `qc_tags_${suffix}` })
        class QcTagEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int", name: "row_id" }) rowId!: number;
          @Column({ type: "varchar", length: 20, name: "tag label" })
          label!: string;
        }
        Row = QcRowEntity as unknown as new () => QcRow;
        Tag = QcTagEntity as unknown as new () => QcTag;
        return { entities: [QcRowEntity, QcTagEntity] };
      },
    );

    // id - amount is 0, -7, -2, 2: ascending that is rows 2, 3, 1, 4, an
    // order neither id nor first-name gives, so an ORDER BY that became
    // arithmetic is told apart from one by a column.
    await conn.em.insertMany(Row, [
      { firstName: "bo", twoFactor: 0, amount: 1 },
      { firstName: "ann", twoFactor: 1, amount: 9 },
      { firstName: "bo", twoFactor: 1, amount: 5 },
      { firstName: "cy", twoFactor: 0, amount: 2 },
    ] as any);
    await conn.em.insertMany(Tag, [
      { rowId: 1, label: "x" },
      { rowId: 2, label: "y" },
      { rowId: 3, label: "x" },
    ] as any);
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  const qb = () => conn.em.createQueryBuilder(Row, "r");

  it("groups and orders by a hyphenated DB column name (was: no such column: first)", async () => {
    const rows = await qb()
      .selectRaw(["first-name", "COUNT(*) AS cnt"])
      .groupBy(["first-name"])
      .addOrderBy("first-name", "DESC")
      .getRawMany();

    expect(rows.map((x: any) => [x["first-name"], Number(x.cnt)])).toEqual([
      ["cy", 1],
      ["bo", 2],
      ["ann", 1],
    ]);
  });

  it("quotes an alias-qualified hyphenated name and one starting with a digit", async () => {
    const built = qb()
      .selectRaw(["r.first-name"])
      .addOrderBy("2fa_enabled", "DESC")
      .addOrderBy("r.id", "ASC");

    expect(built.getSql().text).toContain(`"r"."first-name"`);
    expect(built.getSql().text).toContain(`"r"."2fa_enabled" DESC`);
    const rows = await built.getRawMany();
    expect(rows.map((x: any) => x["first-name"])).toEqual(["ann", "bo", "bo", "cy"]);
  });

  it("orders by a hyphenated name as the column, not as the difference of two columns", async () => {
    // `id-amount` is not a column here, so it stays an expression: the
    // difference, ascending. `first-name` is a column.
    const byDifference = await qb().addOrderBy("id-amount", "ASC").getMany();
    expect(byDifference.map((x) => x.id)).toEqual([2, 3, 1, 4]);

    const byName = await qb()
      .addOrderBy("first-name", "ASC")
      .addOrderBy("id", "ASC")
      .getMany();
    expect(byName.map((x) => x.firstName)).toEqual(["ann", "bo", "bo", "cy"]);
  });

  it("resolves a joined alias's column whose name holds a space", async () => {
    const rows = await qb()
      .leftJoin(Tag, "t", (j: any) => j.on("t.rowId", "=", "r.id"))
      .selectRaw(["t.tag label", "COUNT(*) AS cnt"])
      .groupBy(["t.tag label"])
      .addOrderBy("t.tag label", "ASC")
      .getRawMany();

    expect(rows.map((x: any) => [x["tag label"], Number(x.cnt)])).toEqual([
      [null, 1],
      ["x", 2],
      ["y", 1],
    ]);
  });

  it("addSelect() and window partitionBy() take the name too", async () => {
    const r = qAlias(Row, "r");
    const rows = await qb()
      .select([
        r.id.as("id"),
        rowNumber().partitionBy("first-name").orderBy(r.id.desc()).as("rn"),
      ])
      .addSelect("2fa_enabled", "tfa")
      .addOrderBy("id", "ASC")
      .getRawMany();

    expect(rows.map((x: any) => [Number(x.id), Number(x.rn), Number(x.tfa)])).toEqual([
      [1, 2, 0],
      [2, 1, 1],
      [3, 1, 1],
      [4, 1, 0],
    ]);
  });

  it("keeps an addSelect() string or aggregate added after an expression select() (was: dropped from the SQL)", async () => {
    const r = qAlias(Row, "r");
    const rows = await qb()
      .select([r.firstName.as("fn")])
      .addSelect("amount", "amt")
      .addSelect(r.id.count().as("n"))
      .groupBy(["first-name", "amount"])
      .addOrderBy("amount", "ASC")
      .getRawMany();

    expect(rows.map((x: any) => [x.fn, Number(x.amt), Number(x.n)])).toEqual([
      ["bo", 1, 1],
      ["cy", 2, 1],
      ["bo", 5, 1],
      ["ann", 9, 1],
    ]);
  });

  it("still emits a string that names no column verbatim", async () => {
    let message = "";
    try {
      await qb().addOrderBy("first-nam", "ASC").getMany();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/no such column: first/);
  });
});
