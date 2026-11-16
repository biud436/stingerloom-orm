/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `double` is a binary float and `decimal` an exact number, on SQLite as on
 * the server databases.
 *
 * `double` used to be created as DECIMAL(10, 2) / NUMERIC(10, 2) on MySQL and
 * PostgreSQL and as REAL here, so one entity rounded to two places on one
 * database and kept every digit on another. `t.decimal(p, s)` created an
 * INTEGER column and dropped its precision. Now `double` is REAL here and a
 * float everywhere, and `decimal` is NUMERIC(p, s): SQLite stores it with
 * NUMERIC affinity (sorted and compared as a number), and it reads back the
 * way the column's `decimalMode` asks.
 */
import "reflect-metadata";
import { Column, Entity, PrimaryGeneratedColumn } from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { SchemaDiff } from "../../../src/core/generators/SchemaDiff";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { defineEntity, defineRow, t, type InferEntity } from "../../../src/schema";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";

@Entity({ name: "ddc_measures" })
class DdcMeasure {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "double" }) ratio!: number;
  @Column({ type: "decimal" }) price!: number;
  @Column({ type: "decimal", precision: 12, scale: 4, decimalMode: "string" }) exact!: string;
}

const DdcInvoice = defineEntity("ddc_invoices", {
  id: t.int().primary().generated(),
  total: t.decimal(12, 4),
  shown: t.decimal(10, 2, { mode: "string" }),
});

// Compiles only while the builders infer number / string.
const sampleInvoice: InferEntity<typeof DdcInvoice> = { id: 1, total: 1.5, shown: "1.50" };

describe("[SQLite] double and decimal columns", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [DdcMeasure, DdcInvoice],
      synchronize: { mode: true, continueOnError: false },
    } as any);
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  afterEach(async () => {
    await em.query(`DELETE FROM "ddc_measures"`);
    await em.query(`DELETE FROM "ddc_invoices"`);
  });

  const declaredTypes = async (table: string) => {
    const columns = (await em.query(`PRAGMA table_info("${table}")`)) as any[];
    return Object.fromEntries(columns.map((c) => [c.name, c.type]));
  };

  it("creates REAL for double and NUMERIC(p, s) for decimal", async () => {
    expect(await declaredTypes("ddc_measures")).toMatchObject({
      ratio: "REAL",
      price: "NUMERIC(10, 2)",
      exact: "NUMERIC(12, 4)",
    });
    expect(await declaredTypes("ddc_invoices")).toMatchObject({
      total: "NUMERIC(12, 4)",
      shown: "NUMERIC(10, 2)",
    });
  });

  it("reads double and decimal as numbers, and a string-mode decimal padded to its scale", async () => {
    await em.save(DdcMeasure, { ratio: 1234.56789, price: 19.9, exact: "7.5" } as any);

    const [row] = await em.find(DdcMeasure);
    expect(row.ratio).toBe(1234.56789);
    expect(row.price).toBe(19.9);
    expect(row.exact).toBe("7.5000");
  });

  it("reads t.decimal(p, s) the way its mode asks", async () => {
    await em.save(DdcInvoice, { total: 19.9, shown: 3 } as any);

    const [invoice] = await em.find(DdcInvoice);
    expect(invoice).toMatchObject({ total: 19.9, shown: "3.00" });
    expect(typeof sampleInvoice.shown).toBe("string");
  });

  it("sorts and compares decimal values as numbers", async () => {
    for (const price of ["9.50", "10.25", "100"]) {
      await em.save(DdcMeasure, { ratio: 0, price, exact: "0" } as any);
    }

    const sorted = await em.find(DdcMeasure, { orderBy: { price: "ASC" } });
    expect(sorted.map((m) => m.price)).toEqual([9.5, 10.25, 100]);
    const above = await em.find(DdcMeasure, { where: { price: { gt: 10 } } as any });
    expect(above.map((m) => m.price).sort((a, b) => a - b)).toEqual([10.25, 100]);
  });

  it("reads a decimal through a row shape like find() does", async () => {
    await em.save(DdcMeasure, { ratio: 0, price: "2.25", exact: "1" } as any);
    await em.save(DdcMeasure, { ratio: 0, price: "3.50", exact: "2" } as any);

    const Totals = defineRow({
      total: t.decimal(10, 2),
      exactTotal: t.decimal(12, 4, { mode: "string" }).name("exact_total"),
    });
    const [totals] = await em.query(Totals)`
      SELECT SUM(price) AS total, SUM(exact) AS exact_total FROM ddc_measures`;
    expect(totals).toEqual({ total: 5.75, exactTotal: "3.0000" });
  });

  it("reports no drift once synchronize created the columns", async () => {
    const diff = await new SchemaDiff().diff(
      [DdcMeasure, DdcInvoice] as any,
      { query: async (statement: any) => (await em.query(statement)) as any },
      "sqlite",
    );
    expect(diff.alterColumns).toEqual([]);
    expect(diff.addColumns).toEqual([]);
  });

  it("rejects precision or scale on a double", async () => {
    @Entity({ name: "ddc_bad_measures" })
    class DdcBadMeasure {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "double", precision: 10, scale: 2 }) amount!: number;
    }

    const bad = new EntityManager();
    try {
      await expect(
        bad.register({
          type: "sqlite",
          database: ":memory:",
          entities: [DdcBadMeasure],
          synchronize: true,
          logging: false,
        } as any),
      ).rejects.toMatchObject({
        code: OrmErrorCode.INVALID_CONFIG,
        message: expect.stringContaining(
          'Column ddc_bad_measures.amount declares precision 10 and scale 2 on type "double"',
        ),
      });
    } finally {
      await (bad as unknown as { destroy?: () => Promise<void> }).destroy?.();
    }
  });
});
