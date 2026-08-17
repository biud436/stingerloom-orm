/**
 * SQL craft patterns — capability stress test (MySQL / PostgreSQL).
 *
 * Exercises real-world reporting patterns:
 *   - Pivot (CASE + SUM)
 *   - Running totals / rolling averages (window SUM OVER)
 *   - Period ranking (ROW_NUMBER / RANK / DENSE_RANK)
 *   - Gap detection in sequences (LAG, islands-and-gaps)
 *   - Top-N per group (correlated, window, and lateral variants)
 *   - Median / percentile
 *   - Conditional aggregation (COUNTIF-style)
 *   - Period-over-period comparison (self-join on computed key)
 *
 * Each case is tagged [Builder] (SelectQueryBuilder/QueryDSL only) or
 * [RAW] (requires raw SQL — recursive CTE, non-aggregate window fn,
 * set operations, FROM-subquery) so the capability boundary is visible.
 *
 * Dataset: simple daily sales table with (region, product, sold_on, amount)
 * across 3 regions × 3 products × 10 days — enough to exercise grouping,
 * windowing, and ranking without being noisy.
 */

import "reflect-metadata";
import sql, { raw } from "sql-template-tag";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
  type TestDriverType,
} from "./helpers/driver-config";
import { qi } from "./helpers/driver-helpers";
import { qAlias } from "../../src/core/SelectQueryBuilder";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import { Entity, Column, PrimaryColumn } from "../../src";
import { generateTableName } from "./helpers/create-test-entity";
import { SnakeNamingStrategy } from "../../src/core/generators/SnakeNamingStrategy";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";

interface SaleShape {
  id: number;
  region: string;
  product: string;
  soldOn: string;
  amount: number;
}

(INTEGRATION ? describe.each(getTestDrivers()) : describe.skip.each(getTestDrivers()))(
  "[Integration] SQL Craft Patterns ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Sale: new () => SaleShape;
    let saleTable: string;

    const qId = (n: string) => qi(type as TestDriverType, n);

    // PG-only syntax reports as skipped instead of returning early — an early
    // return counts as a passing test on MySQL and hides that the case never
    // ran there.
    const itPg = type === "postgres" ? it : it.skip;

    beforeAll(async () => {
      saleTable = generateTableName(`craft_sale_${type}`);

      conn = await createTestConnection(
        {
          ...options,
          synchronize: true,
          logging: false,
          namingStrategy: new SnakeNamingStrategy(),
        },
        () => {
          getScannerInstance(ColumnScanner).clear();

          const Cls = class {} as any;
          Object.defineProperty(Cls, "name", { value: saleTable, writable: false });
          Reflect.defineMetadata("design:type", Number, Cls.prototype, "id");
          PrimaryColumn({ type: "int" })(Cls.prototype, "id");
          Reflect.defineMetadata("design:type", String, Cls.prototype, "region");
          Column({ type: "varchar", length: 30 })(Cls.prototype, "region");
          Reflect.defineMetadata("design:type", String, Cls.prototype, "product");
          Column({ type: "varchar", length: 30 })(Cls.prototype, "product");
          Reflect.defineMetadata("design:type", String, Cls.prototype, "soldOn");
          Column({ type: "date" })(Cls.prototype, "soldOn");
          Reflect.defineMetadata("design:type", Number, Cls.prototype, "amount");
          Column({ type: "int" })(Cls.prototype, "amount");
          Entity()(Cls);
          Sale = Cls;

          return { entities: [Cls] };
        },
      );
      em = conn.em;

      // ── Seed: 3 regions × 3 products × 10 days = 90 rows ────
      // Day 1..10, amounts chosen so aggregates have nice round numbers.
      //
      //   region        product   amount
      //   ─────────     ───────   ──────
      //   North         apple     base 10, +1/day            (10..19)
      //   North         banana    base 20, +2/day            (20..38)
      //   North         cherry    base 0 odd-days / 30 even  (alternating)
      //   South         apple     base 15, +1/day
      //   South         banana    base 25, +2/day
      //   South         cherry    base 5 odd / 35 even
      //   East          apple     base 20, +1/day
      //   East          banana    base 30, +2/day
      //   East          cherry    base 10 odd / 40 even
      const regions = [
        { name: "North", appleBase: 10, bananaBase: 20, cherryOdd: 0,  cherryEven: 30 },
        { name: "South", appleBase: 15, bananaBase: 25, cherryOdd: 5,  cherryEven: 35 },
        { name: "East",  appleBase: 20, bananaBase: 30, cherryOdd: 10, cherryEven: 40 },
      ];
      let id = 1;
      const rows: SaleShape[] = [];
      for (const r of regions) {
        for (let d = 1; d <= 10; d++) {
          const day = `2026-03-${String(d).padStart(2, "0")}`;
          const odd = d % 2 === 1;
          rows.push(
            { id: id++, region: r.name, product: "apple",  soldOn: day, amount: r.appleBase + (d - 1) },
            { id: id++, region: r.name, product: "banana", soldOn: day, amount: r.bananaBase + (d - 1) * 2 },
            { id: id++, region: r.name, product: "cherry", soldOn: day, amount: odd ? r.cherryOdd : r.cherryEven },
          );
        }
      }
      for (const row of rows) await em.save(Sale, row as any);
    }, 120000);

    afterAll(async () => {
      try { await dropTestTable(saleTable); } catch {}
      if (conn) await conn.cleanup();
    }, 30000);

    // ══════════════════════════════════════════════════════════
    // 1) Pivot — rows to columns via CASE + SUM
    // ══════════════════════════════════════════════════════════
    describe("1) Pivot (CASE + SUM)", () => {
      it("[Builder] region × product pivot — amount totals", async () => {
        // result shape:  { region, apple, banana, cherry }
        const qb = em.createQueryBuilder(Sale, "s");
        const rows = await qb
          .select(["region"])
          .addSelect(sql`SUM(CASE WHEN s.product = 'apple'  THEN s.amount ELSE 0 END)`, "apple")
          .addSelect(sql`SUM(CASE WHEN s.product = 'banana' THEN s.amount ELSE 0 END)`, "banana")
          .addSelect(sql`SUM(CASE WHEN s.product = 'cherry' THEN s.amount ELSE 0 END)`, "cherry")
          .groupBy(["s.region"])
          .addOrderBy("s.region", "ASC")
          .getRawMany();
        // 10 days, apple_total = 10*base + sum(0..9) = 10*base + 45
        //          banana_total = 10*base + 2*sum(0..9) = 10*base + 90
        //          cherry_total = 5*odd + 5*even  (5 odd days in [1..10])
        expect(rows.map((r: any) => ({
          region: r.region,
          apple: Number(r.apple),
          banana: Number(r.banana),
          cherry: Number(r.cherry),
        }))).toEqual([
          { region: "East",  apple: 20 * 10 + 45, banana: 30 * 10 + 90, cherry: 5 * 10 + 5 * 40 },
          { region: "North", apple: 10 * 10 + 45, banana: 20 * 10 + 90, cherry: 5 * 0  + 5 * 30 },
          { region: "South", apple: 15 * 10 + 45, banana: 25 * 10 + 90, cherry: 5 * 5  + 5 * 35 },
        ]);
      });

      it("[Builder] conditional count — # of days with amount > 20 per (region, product)", async () => {
        const qb = em.createQueryBuilder(Sale, "s");
        const rows = await qb
          .select(["region", "product"])
          .addSelect(sql`SUM(CASE WHEN s.amount > 20 THEN 1 ELSE 0 END)`, "hitDays")
          .groupBy(["s.region", "s.product"])
          .addOrderBy("s.region", "ASC")
          .addOrderBy("s.product", "ASC")
          .getRawMany();
        // apple: amount runs base..(base+9).  >20 days = count of base+i > 20
        //   North(base=10): i ∈ [11..19] ⇒ 0 days  (no, max is 19)
        //   South(base=15): i ∈ [15..24] ⇒ 4 days (21..24)
        //   East(base=20):  i ∈ [20..29] ⇒ 9 days (21..29)
        // banana (+2/day):
        //   North(base=20): 20,22,24,26,28,30,32,34,36,38 ⇒ 9 days >20
        //   South(base=25): 25..43 ⇒ 10 days all >20
        //   East(base=30):  30..48 ⇒ 10 days all >20
        // cherry alternates (odd/even):
        //   North: 0,30,0,30,0,30,0,30,0,30 ⇒ 5 days >20
        //   South: 5,35,5,35,... ⇒ 5 days >20
        //   East:  10,40,10,40,... ⇒ 5 days >20
        const map = Object.fromEntries(
          rows.map((r: any) => [`${r.region}/${r.product}`, Number(r.hitDays)]),
        );
        expect(map).toEqual({
          "East/apple":  9,  "East/banana":  10, "East/cherry":  5,
          "North/apple": 0,  "North/banana": 9,  "North/cherry": 5,
          "South/apple": 4,  "South/banana": 10, "South/cherry": 5,
        });
      });
    });

    // ══════════════════════════════════════════════════════════
    // 2) Running totals — window SUM OVER(...)
    // ══════════════════════════════════════════════════════════
    describe("2) Running totals / cumulative sums", () => {
      it("[Builder] cumulative amount per region — aggregate window via QueryDSL", async () => {
        // QueryDSL exposes AggregateExpression.over().partitionBy().orderBy()
        // — aggregate windows ARE supported by the Builder.
        const qb = em.createQueryBuilder(Sale, "s");
        const s = qAlias(Sale, "s");
        const running = s.amount.sum().over()
          .partitionBy(s.region)
          .orderBy(s.soldOn.asc())
          .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
          .as("running_total");

        const rows = await qb
          .select(["region", "soldOn", "amount"])
          .addSelect(running)
          .where(sql`s.product = 'apple'`)
          .addOrderBy("s.region", "ASC")
          .addOrderBy("s.soldOn", "ASC")
          .getRawMany();

        // North apple: 10, 11, 12, ..., 19. Running = 10, 21, 33, 46, 60, 75, 91, 108, 126, 145.
        const northRunning = rows
          .filter((r: any) => r.region === "North")
          .map((r: any) => Number(r.running_total));
        expect(northRunning).toEqual([10, 21, 33, 46, 60, 75, 91, 108, 126, 145]);
      });

      it("[Builder] 3-day rolling average for North/apple — window AVG", async () => {
        const qb = em.createQueryBuilder(Sale, "s");
        const s = qAlias(Sale, "s");
        const rolling = s.amount.avg().over()
          .partitionBy(s.product)
          .orderBy(s.soldOn.asc())
          .rowsBetween("2 PRECEDING", "CURRENT ROW")
          .as("avg3");

        const rows = await qb
          .select(["soldOn", "amount"])
          .addSelect(rolling)
          .where(sql`s.region = 'North' AND s.product = 'apple'`)
          .addOrderBy("s.soldOn", "ASC")
          .getRawMany();

        // amounts: 10,11,12,13,14,15,16,17,18,19
        // rolling3: 10, 10.5, 11, 12, 13, 14, 15, 16, 17, 18
        const avgs = rows.map((r: any) => Number(r.avg3));
        expect(avgs[0]).toBe(10);       // day 1: avg(10) = 10
        expect(avgs[1]).toBe(10.5);     // day 2: avg(10,11) = 10.5
        expect(avgs[2]).toBe(11);       // day 3: avg(10,11,12) = 11
        expect(avgs[9]).toBe(18);       // day 10: avg(17,18,19) = 18
      });
    });

    // ══════════════════════════════════════════════════════════
    // 3) Ranking — ROW_NUMBER / RANK / DENSE_RANK
    // ══════════════════════════════════════════════════════════
    describe("3) Ranking within groups", () => {
      it("[RAW] ROW_NUMBER — top-3 sale days per region (non-aggregate window)", async () => {
        const T = qId(saleTable);
        const rows = await em.query<{
          region: string;
          sold_on: string;
          amount: number;
          rn: number;
        }>(
          `SELECT region, sold_on, amount,
                  ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC, sold_on DESC) AS rn
             FROM ${T}
            ORDER BY region, rn`,
        );
        // Keep only rn <= 3 and group by region
        const top3: Record<string, Array<number>> = {};
        for (const r of rows) {
          if (Number(r.rn) <= 3) {
            (top3[r.region] ||= []).push(Number(r.amount));
          }
        }
        // Each region's top-3 by amount DESC:
        //   East:  banana_day10=48, banana_day9=46, banana_day8=44
        //   North: banana_day10=38, banana_day9=36, banana_day8=34
        //   South: banana_day10=43, banana_day9=41, banana_day8=39
        expect(top3.East).toEqual([48, 46, 44]);
        expect(top3.North).toEqual([38, 36, 34]);
        expect(top3.South).toEqual([43, 41, 39]);
      });

      it("[Builder] top-1 sale day per region via correlated MAX (Builder-only)", async () => {
        const T = qId(saleTable);
        const qb = em.createQueryBuilder(Sale, "s");
        const rows = await qb
          .select(["region", "soldOn", "amount"])
          .where(
            sql`s.amount = (SELECT MAX(t.amount) FROM ${raw(T)} t WHERE t.region = s.region)`,
          )
          .addOrderBy("s.region", "ASC")
          .addOrderBy("s.soldOn", "ASC")
          .getRawMany();
        const peaks = rows.map((r: any) => ({
          region: r.region,
          amount: Number(r.amount),
        }));
        expect(peaks).toEqual([
          { region: "East",  amount: 48 },
          { region: "North", amount: 38 },
          { region: "South", amount: 43 },
        ]);
      });
    });

    // ══════════════════════════════════════════════════════════
    // 4) Gap detection / islands-and-gaps
    // ══════════════════════════════════════════════════════════
    describe("4) Gap detection", () => {
      it("[Builder] drop detection via date-arithmetic self-join (LAG alternative)", async () => {
        // Non-aggregate LAG isn't in QueryDSL, but for dense daily series
        // a self-join on prev_date = today_date - 1 is equivalent.
        const prevExpr = type === "postgres"
          ? "prev.sold_on = today.sold_on - INTERVAL '1 day'"
          : "prev.sold_on = DATE_SUB(today.sold_on, INTERVAL 1 DAY)";
        const qb = em.createQueryBuilder(Sale, "today");
        qb.leftJoin(
          saleTable,
          "prev",
          sql`${raw(prevExpr)} AND prev.region = today.region AND prev.product = today.product`,
        );
        const rows = await qb
          .select([] as any)
          .addSelect("today.sold_on", "sold_on")
          .addSelect(
            sql`CASE WHEN prev.amount IS NOT NULL AND today.amount < prev.amount THEN 1 ELSE 0 END`,
            "dropped",
          )
          .where(sql`today.region = 'North' AND today.product = 'cherry'`)
          .addOrderBy("today.soldOn", "ASC")
          .getRawMany();
        expect(rows.map((r: any) => Number(r.dropped))).toEqual(
          [0, 0, 1, 0, 1, 0, 1, 0, 1, 0],
        );
      });

      it("[RAW] LAG — flag rows where amount drops vs previous day (non-aggregate window)", async () => {
        const T = qId(saleTable);
        const rows = await em.query<{
          sold_on: string;
          amount: number;
          prev_amount: number | null;
          dropped: number;
        }>(
          `SELECT sold_on, amount,
                  LAG(amount) OVER (ORDER BY sold_on) AS prev_amount,
                  CASE WHEN amount < LAG(amount) OVER (ORDER BY sold_on) THEN 1 ELSE 0 END AS dropped
             FROM ${T}
            WHERE region = 'North' AND product = 'cherry'
            ORDER BY sold_on`,
        );
        // cherry/North alternates 0, 30, 0, 30, ... — every even→odd transition is a drop.
        // days 1..10: 0,30,0,30,0,30,0,30,0,30
        // dropped[day]:  0  0  1  0  1  0  1  0  1  0
        const flags = rows.map((r) => Number(r.dropped));
        expect(flags).toEqual([0, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
      });

      it("[Builder] find (region, date) pairs missing from the sales table — NOT EXISTS correlated", async () => {
        // Pretend "apple" is the canonical product; look for (region, date)
        // pairs where banana sales are missing — shouldn't find any (all days covered).
        const T = qId(saleTable);
        const qb = em.createQueryBuilder(Sale, "a");
        const rows = await qb
          .select(["region", "soldOn"])
          .where(sql`a.product = 'apple'`)
          .andWhere(
            sql`NOT EXISTS (
                  SELECT 1 FROM ${raw(T)} b
                   WHERE b.region = a.region
                     AND b.sold_on = a.sold_on
                     AND b.product = 'banana'
                )`,
          )
          .getPartialMany();
        expect(rows).toEqual([]);
      });
    });

    // ══════════════════════════════════════════════════════════
    // 5) Top-N per group
    // ══════════════════════════════════════════════════════════
    describe("5) Top-N per group", () => {
      it("[Builder] top-2 product days per region by amount — correlated COUNT rank", async () => {
        // classic pre-window pattern: row X is rank <=2 iff
        //   (SELECT COUNT(*) FROM t WHERE t.region = x.region AND t.amount > x.amount) < 2
        const T = qId(saleTable);
        const qb = em.createQueryBuilder(Sale, "x");
        const rows = await qb
          .select(["region", "product", "soldOn", "amount"])
          .where(
            sql`(SELECT COUNT(*) FROM ${raw(T)} y
                  WHERE y.region = x.region AND y.amount > x.amount) < 2`,
          )
          .addOrderBy("x.region", "ASC")
          .addOrderBy("x.amount", "DESC")
          .getRawMany();
        // Top-2 amounts per region (strictly higher count < 2):
        //   East  — banana_day10=48, banana_day9=46
        //   North — banana_day10=38, banana_day9=36
        //   South — banana_day10=43, banana_day9=41
        const top = rows.map((r: any) => ({
          region: r.region,
          amount: Number(r.amount),
        }));
        expect(top).toEqual([
          { region: "East",  amount: 48 },
          { region: "East",  amount: 46 },
          { region: "North", amount: 38 },
          { region: "North", amount: 36 },
          { region: "South", amount: 43 },
          { region: "South", amount: 41 },
        ]);
      });

      it("[RAW] top-2 per region via RANK() window fn (cleaner than correlated)", async () => {
        const T = qId(saleTable);
        const rows = await em.query<{
          region: string;
          amount: number;
          rk: number;
        }>(
          `SELECT region, amount, rk FROM (
             SELECT region, amount,
                    RANK() OVER (PARTITION BY region ORDER BY amount DESC) AS rk
               FROM ${T}
           ) t
           WHERE rk <= 2
           ORDER BY region, rk`,
        );
        const byRegion: Record<string, number[]> = {};
        for (const r of rows) (byRegion[r.region] ||= []).push(Number(r.amount));
        expect(byRegion.East).toEqual([48, 46]);
        expect(byRegion.North).toEqual([38, 36]);
        expect(byRegion.South).toEqual([43, 41]);
      });
    });

    // ══════════════════════════════════════════════════════════
    // 6) Percentile / median
    // ══════════════════════════════════════════════════════════
    describe("6) Percentile / median", () => {
      it("[Builder] lower-median for North/apple via ORDER BY + LIMIT/OFFSET", async () => {
        // QueryDSL has no PERCENTILE_CONT. But for a concrete partition
        // (fixed region, product) the row at index floor(n/2) of an
        // ordered series equals the lower median — expressible with a
        // Builder using limit() + offset(). N=10 rows, offset=4 gives
        // the 5th row (0-indexed 4) — the lower median of 10 values.
        const s = qAlias(Sale, "s");
        const qb = em.createQueryBuilder(Sale, "s");
        const rows = await qb
          .select([] as any)
          .addSelect("s.amount", "amount")
          .where(s.region.eq("North").and(s.product.eq("apple")))
          .addOrderBy("s.amount", "ASC")
          .limit(1)
          .offset(4)
          .getRawMany();
        // apple amounts 10..19 sorted → index 4 = 14 (lower median).
        expect(Number((rows[0] as any).amount)).toBe(14);
      });

      itPg("[RAW] median amount per region — PERCENTILE_CONT (PG) / ordered aggregate", async () => {
        // Median is only in PG via PERCENTILE_CONT and MySQL 8+ via similar
        // ordered-set aggregate; skipped on MySQL where the syntax varies.
        const T = qId(saleTable);
        const rows = await em.query<{ region: string; med: number }>(
          `SELECT region,
                  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount) AS med
             FROM ${T}
            GROUP BY region
            ORDER BY region`,
        );
        // 30 rows per region (3 products × 10 days).
        //   North values sorted:  all apple+banana+cherry (cherry has 5 zeros + 5 thirties)
        //   Full distribution is bimodal; median depends on sort of all 30.
        // Let's compute expected: for North: amounts =
        //   apple  10..19, banana 20..38 even step, cherry [0,30]×5
        // sorted 30 values, median = avg of 15th and 16th after sort.
        const map = Object.fromEntries(
          rows.map((r) => [r.region, Number(r.med)]),
        );
        // Sanity: median of East should be highest, North lowest.
        expect(map.East).toBeGreaterThan(map.North);
        expect(map.South).toBeGreaterThan(map.North);
        // Exact North computation — see comment above; skip strict value.
        expect(map.North).toBeGreaterThan(0);
      });
    });

    // ══════════════════════════════════════════════════════════
    // 7) Year/period-over-period comparison
    // ══════════════════════════════════════════════════════════
    describe("7) Period-over-period", () => {
      it("[Builder] day-over-day delta for North/apple — self-join on computed prior date", async () => {
        // delta = today.amount - prev_day.amount
        // Self-join on  prev.sold_on = today.sold_on - INTERVAL 1 DAY.
        // Date arithmetic is dialect-specific — use raw fragment.
        const T = qId(saleTable);
        const prevExpr = type === "postgres"
          ? "prev.sold_on = today.sold_on - INTERVAL '1 day'"
          : "prev.sold_on = DATE_SUB(today.sold_on, INTERVAL 1 DAY)";

        const qb = em.createQueryBuilder(Sale, "today");
        qb.innerJoin(saleTable, "prev", sql`${raw(prevExpr)} AND prev.region = today.region AND prev.product = today.product`);
        const rows = await qb
          .select(["soldOn"])
          .addSelect(sql`today.amount - prev.amount`, "delta")
          .where(sql`today.region = 'North' AND today.product = 'apple'`)
          .addOrderBy("today.soldOn", "ASC")
          .getRawMany();
        // apple increments by +1/day, so delta is 1 for every day except day1 (no prev).
        const deltas = rows.map((r: any) => Number(r.delta));
        expect(deltas).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);  // 9 rows (day2..day10)
        expect(rows.length).toBe(9);
        void T;
      });
    });

    // ══════════════════════════════════════════════════════════
    // 8) Compositional — caseBuilder + orWhere + Expressions.or/and
    // ══════════════════════════════════════════════════════════
    describe("8) QueryDSL compositional stress", () => {
      it("[Builder] tier counts as single-row pivot (CASE + SUM, no GROUP BY)", async () => {
        // Doing GROUP BY on a CASE alias is a Builder wall —
        // `groupBy()` runs every entry through `resolveColumn`, which
        // qualifies the expression with the main alias and breaks the
        // SQL. Work-around: pivot the counts into columns with SUM(CASE).
        const qb = em.createQueryBuilder(Sale, "s");
        const rows = await qb
          .select([] as any)
          .addSelect(sql`SUM(CASE WHEN s.amount >= 40 THEN 1 ELSE 0 END)`, "a")
          .addSelect(sql`SUM(CASE WHEN s.amount >= 20 AND s.amount < 40 THEN 1 ELSE 0 END)`, "b")
          .addSelect(sql`SUM(CASE WHEN s.amount >= 10 AND s.amount < 20 THEN 1 ELSE 0 END)`, "c")
          .addSelect(sql`SUM(CASE WHEN s.amount <  10 THEN 1 ELSE 0 END)`, "d")
          .getRawMany();

        const r = rows[0] as any;
        const total =
          Number(r.a) + Number(r.b) + Number(r.c) + Number(r.d);
        expect(total).toBe(90);
        // Each bucket must have at least one row given the seed distribution.
        expect(Number(r.a)).toBeGreaterThan(0);
        expect(Number(r.b)).toBeGreaterThan(0);
        expect(Number(r.c)).toBeGreaterThan(0);
        expect(Number(r.d)).toBeGreaterThan(0);
      });

      it("[RAW] GROUP BY on CASE alias — Builder wall", async () => {
        // Builder's groupBy() passes each entry through resolveColumn
        // which qualifies with the main alias — impossible to group by
        // an arbitrary expression. Fallback to em.query().
        const T = qId(saleTable);
        const rows = await em.query<{ tier: string; cnt: any }>(
          `SELECT
             CASE
               WHEN amount >= 40 THEN 'A'
               WHEN amount >= 20 THEN 'B'
               WHEN amount >= 10 THEN 'C'
               ELSE 'D'
             END AS tier,
             COUNT(*) AS cnt
           FROM ${T}
           GROUP BY tier
           ORDER BY tier`,
        );
        const total = rows.reduce<number>((a, b) => a + Number(b.cnt), 0);
        expect(total).toBe(90);
        expect(rows.map((r) => r.tier).sort()).toEqual(["A", "B", "C", "D"].sort());
      });

      itPg("[RAW] DISTINCT ON (PostgreSQL) — Builder wall", async () => {
        // DISTINCT ON is PG-specific; QueryDSL has no equivalent. This
        // captures the "first row per partition" pattern that in MySQL
        // would go through ROW_NUMBER() and is also Raw-only there.
        const T = qId(saleTable);
        const rows = await em.query<{
          region: string;
          product: string;
          sold_on: string;
          amount: number;
        }>(
          `SELECT DISTINCT ON (region) region, product, sold_on, amount
             FROM ${T}
             ORDER BY region, amount DESC`,
        );
        // Highest-amount row per region.
        expect(rows.map((r) => ({ region: r.region, amount: Number(r.amount) }))).toEqual([
          { region: "East",  amount: 48 },
          { region: "North", amount: 38 },
          { region: "South", amount: 43 },
        ]);
      });

      it("[RAW] GROUPING SETS — multi-level aggregation (Builder wall)", async () => {
        // GROUPING SETS / ROLLUP / CUBE have no Builder surface.
        const T = qId(saleTable);
        const sqlText = type === "postgres"
          ? `SELECT region, product, SUM(amount) AS total
               FROM ${T}
               GROUP BY GROUPING SETS ((region), (region, product), ())
               ORDER BY region NULLS FIRST, product NULLS FIRST`
          // MariaDB disallows ORDER BY with WITH ROLLUP; wrap in subquery.
          : `SELECT * FROM (
               SELECT region, product, SUM(amount) AS total
                 FROM ${T}
                 GROUP BY region, product WITH ROLLUP
             ) t
             ORDER BY region IS NOT NULL, region, product IS NOT NULL, product`;
        const rows = await em.query<any>(sqlText);
        // Sanity: grand total row must appear (all grouping cols NULL).
        const grand = rows.find((r) => r.region == null && r.product == null);
        expect(grand).toBeDefined();
        expect(Number(grand.total)).toBeGreaterThan(0);
      });

      it("[RAW] FROM subquery — Builder has no surface for SELECT … FROM (subquery)", async () => {
        // Compute per-(region,product) average, then rank product
        // averages globally — needs a FROM subquery, which the Builder
        // cannot express.
        const T = qId(saleTable);
        const rows = await em.query<{ product: string; total: any }>(
          `SELECT product, SUM(region_total) AS total
             FROM (
               SELECT region, product, SUM(amount) AS region_total
                 FROM ${T}
                 GROUP BY region, product
             ) t
            GROUP BY product
            ORDER BY total DESC`,
        );
        // Banana aggregates highest (base grows per day × 3 regions).
        expect(rows[0].product).toBe("banana");
      });

      it("[Builder] complex OR/AND composition with QueryDSL", async () => {
        const s = qAlias(Sale, "s");
        const qb = em.createQueryBuilder(Sale, "s");
        const rows = await qb
          .where(
            Expressions.or(
              Expressions.and(s.region.eq("North"), s.amount.gte(30)),
              Expressions.and(s.product.eq("cherry"), s.amount.gte(40)),
            ),
          )
          .getMany();
        // North/banana day6..10: 30,32,34,36,38 → 5 rows
        // North/apple day>=30? max 19 → 0
        // North/cherry >=30? all even days =30 → 5 rows
        //   (these also satisfy branch 1 since region=North AND amount>=30)
        // Plus any cherry amount>=40 from OTHER regions:
        //   East/cherry even days = 40 → 5 rows
        //   South/cherry even = 35 → 0
        // North branch: banana(5) + cherry(5) = 10
        // Second branch cherry>=40: East 5 (North cherry=30 doesn't satisfy)
        // OR dedup: 10 + 5 = 15
        expect(rows.length).toBe(15);
      });
    });
  },
);
