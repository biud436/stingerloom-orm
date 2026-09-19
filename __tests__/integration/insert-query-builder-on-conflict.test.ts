/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `em.createInsertBuilder()` against real servers (MySQL/MariaDB +
 * PostgreSQL).
 *
 * Mirrors __tests__/integration/sqlite/insert-query-builder-on-conflict.test.ts.
 * The dialect-specific part is how the conflict action reads the *stored*
 * row: it renders qualified by the table name (`"t"."records"`), because
 * inside PostgreSQL's `DO UPDATE SET` / `WHERE` both the target table and
 * `EXCLUDED` are in scope and a bare column is rejected as ambiguous
 * (`column reference "records" is ambiguous`). MySQL/MariaDB accepts the
 * qualified spelling in `ON DUPLICATE KEY UPDATE` as well.
 *
 * Runs only under INTEGRATION_TEST=true; individual drivers can be disabled
 * with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
 */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryColumn } from "../../src/decorators/PrimaryColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { qAlias } from "../../src/core/query-builder/alias/qAlias";
import { qExcluded } from "../../src/core/query-builder/alias/qExcluded";
import { greatest } from "../../src/core/expressions/ComparisonExpression";
import { iff } from "../../src/core/expressions/CaseExpression";
import {
  createTestConnection,
  rawQuery,
  dropTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const TABLES = {
  marker: "iqb_marker",
  partial: "iqb_partial",
} as const;

type Marker = {
  mac: string;
  bucketStart: number;
  records: number;
  lastTs: number;
};
type Partial_ = {
  id: number;
  mac: string;
  hits: number;
  archivedAt: Date | null;
};

describe.each(drivers)(
  "[Integration][$label] InsertQueryBuilder ON CONFLICT",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let MarkerE: new () => Marker;
    let PartialE: new () => Partial_;

    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: TABLES.marker })
          class MarkerEntity {
            @PrimaryColumn({ type: "varchar", length: 32 }) mac!: string;
            @PrimaryColumn({ type: "int" }) bucketStart!: number;
            @Column({ type: "int" }) records!: number;
            @Column({ type: "int" }) lastTs!: number;
          }

          @Entity({ name: TABLES.partial })
          class PartialEntity {
            @PrimaryColumn({ type: "int" }) id!: number;
            @Column({ type: "varchar", length: 32 }) mac!: string;
            @Column({ type: "int" }) hits!: number;
            @Column({ type: "datetime", nullable: true }) archivedAt!: Date | null;
          }

          MarkerE = MarkerEntity;
          PartialE = PartialEntity;
          return { entities: [MarkerEntity, PartialEntity] };
        },
      );
      em = conn.em;

      if (type === "postgres") {
        // A partial unique index for the arbiter-predicate case: only the
        // live (non-archived) row per mac is unique.
        await rawQuery(
          `CREATE UNIQUE INDEX ${q("iqb_partial_live_mac")} ON ${q(TABLES.partial)} (${q("mac")}) WHERE ${q("archivedAt")} IS NULL`,
        );
      }
    }, 60000);

    afterAll(async () => {
      for (const t of [TABLES.marker, TABLES.partial]) {
        try {
          await dropTestTable(t);
        } catch {
          /* ignore */
        }
      }
      await conn.cleanup();
    });

    beforeEach(async () => {
      for (const t of [TABLES.marker, TABLES.partial]) {
        await rawQuery(`DELETE FROM ${q(t)}`);
      }
    });

    /** `records += excluded.records`, `lastTs = GREATEST(lastTs, excluded.lastTs)`. */
    function accumulate(rows: Array<Partial<Marker>>) {
      return em
        .createInsertBuilder(MarkerE)
        .values(rows as any)
        .onConflict(["mac", "bucketStart"] as any)
        .doUpdate((t: any, ex: any) => ({
          records: t.records.add(ex.records),
          lastTs: greatest(t.lastTs, ex.lastTs),
        }))
        .execute();
    }

    async function readAll(): Promise<Marker[]> {
      return em.find(MarkerE, {
        orderBy: { mac: "ASC", bucketStart: "ASC" },
      } as any) as Promise<Marker[]>;
    }

    it("reads the stored row in the conflict action: accumulates and keeps the high-water mark", async () => {
      await accumulate([
        { mac: "aa", bucketStart: 100, records: 5, lastTs: 150 },
        { mac: "bb", bucketStart: 200, records: 7, lastTs: 250 },
      ]);
      await accumulate([
        { mac: "aa", bucketStart: 100, records: 3, lastTs: 120 },
        { mac: "bb", bucketStart: 200, records: 1, lastTs: 300 },
      ]);

      const rows = await readAll();
      expect(rows.map((r) => [r.mac, r.records, r.lastTs])).toEqual([
        ["aa", 8, 150],
        ["bb", 8, 300],
      ]);
    });

    it("accumulates across three rounds without losing a write", async () => {
      for (let i = 1; i <= 3; i++) {
        await accumulate([{ mac: "aa", bucketStart: 100, records: i, lastTs: i * 10 }]);
      }
      const [row] = await readAll();
      expect(row.records).toBe(6);
      expect(row.lastTs).toBe(30);
    });

    it("folds a stored-vs-proposed guard into every assignment with iff()", async () => {
      const guardedWrite = (rows: Array<Partial<Marker>>) =>
        em
          .createInsertBuilder(MarkerE)
          .values(rows as any)
          .onConflict(["mac", "bucketStart"] as any)
          .doUpdate((t: any, x: any) => ({
            records: iff(x.lastTs.gt(t.lastTs), x.records, t.records),
            lastTs: iff(x.lastTs.gt(t.lastTs), x.lastTs, t.lastTs),
          }))
          .execute();

      await guardedWrite([{ mac: "aa", bucketStart: 100, records: 5, lastTs: 300 }]);
      // Stale replay: older timestamp, different payload — must not win.
      await guardedWrite([{ mac: "aa", bucketStart: 100, records: 99, lastTs: 200 }]);
      let [row] = await readAll();
      expect(row).toMatchObject({ records: 5, lastTs: 300 });

      await guardedWrite([{ mac: "aa", bucketStart: 100, records: 8, lastTs: 400 }]);
      [row] = await readAll();
      expect(row).toMatchObject({ records: 8, lastTs: 400 });
    });

    if (type === "postgres") {
      it("filters the update with a doUpdateWhere predicate that reads the stored row", async () => {
        await accumulate([
          { mac: "aa", bucketStart: 100, records: 5, lastTs: 500 },
          { mac: "bb", bucketStart: 100, records: 5, lastTs: 100 },
        ]);
        const m = qAlias(MarkerE, "m") as any;

        await em
          .createInsertBuilder(MarkerE)
          .values([
            { mac: "aa", bucketStart: 100, records: 1, lastTs: 300 },
            { mac: "bb", bucketStart: 100, records: 1, lastTs: 300 },
          ] as any)
          .onConflict(["mac", "bucketStart"] as any)
          .doUpdate((t: any, x: any) => ({ lastTs: x.lastTs }))
          .doUpdateWhere(m.lastTs.lt(300))
          .execute();

        const rows = await readAll();
        const byMac = Object.fromEntries(rows.map((r) => [r.mac, r]));
        expect(byMac["aa"].lastTs).toBe(500);
        expect(byMac["bb"].lastTs).toBe(300);
      });

      it("compares the stored row against EXCLUDED in doUpdateWhere", async () => {
        const m = qAlias(MarkerE, "m") as any;
        const ex = qExcluded(MarkerE) as any;
        const guardedWrite = (rows: Array<Partial<Marker>>) =>
          em
            .createInsertBuilder(MarkerE)
            .values(rows as any)
            .onConflict(["mac", "bucketStart"] as any)
            .doUpdate((t: any, x: any) => ({ records: x.records, lastTs: x.lastTs }))
            .doUpdateWhere(m.lastTs.lt(ex.lastTs))
            .execute();

        await guardedWrite([{ mac: "aa", bucketStart: 100, records: 5, lastTs: 300 }]);
        await guardedWrite([{ mac: "aa", bucketStart: 100, records: 99, lastTs: 200 }]);
        let [row] = await readAll();
        expect(row).toMatchObject({ records: 5, lastTs: 300 });

        await guardedWrite([{ mac: "aa", bucketStart: 100, records: 8, lastTs: 400 }]);
        [row] = await readAll();
        expect(row).toMatchObject({ records: 8, lastTs: 400 });
      });

      it("infers a partial unique index from an onConflict where predicate", async () => {
        const p = qAlias(PartialE, "p") as any;
        const write = (row: Partial<Partial_>) =>
          em
            .createInsertBuilder(PartialE)
            .values(row as any)
            .onConflict(["mac"] as any, { where: p.archivedAt.isNull() })
            .doUpdate((t: any, x: any) => ({ hits: t.hits.add(x.hits) }))
            .execute();

        await write({ id: 1, mac: "aa", hits: 1, archivedAt: null });
        // Same mac, live → arbitrated by the partial index → accumulates.
        await write({ id: 2, mac: "aa", hits: 2, archivedAt: null });

        const rows = await em.find(PartialE, { orderBy: { id: "ASC" } } as any);
        expect(rows.map((r: any) => [r.id, r.hits])).toEqual([[1, 3]]);
      });
    }

    if (type === "mysql") {
      it("rejects doUpdateWhere before sending anything to the server", async () => {
        const m = qAlias(MarkerE, "m") as any;
        await expect(
          em
            .createInsertBuilder(MarkerE)
            .values({ mac: "aa", bucketStart: 100, records: 1, lastTs: 1 } as any)
            .onConflict(["mac", "bucketStart"] as any)
            .doUpdate((t: any, x: any) => ({ lastTs: x.lastTs }))
            .doUpdateWhere(m.lastTs.lt(300))
            .execute(),
        ).rejects.toThrow(/takes no WHERE clause/);
        expect(await readAll()).toEqual([]);
      });
    }
  },
);
