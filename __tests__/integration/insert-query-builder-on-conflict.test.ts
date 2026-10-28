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
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { UniqueIndex } from "../../src/decorators/UniqueIndex";
import { UpdateTimestamp } from "../../src/decorators/UpdateTimestamp";
import { Version } from "../../src/decorators/Version";
import { EntityManager } from "../../src/core/EntityManager";
import { qAlias } from "../../src/core/query-builder/alias/qAlias";
import { qExcluded } from "../../src/core/query-builder/alias/qExcluded";
import { greatest } from "../../src/core/expressions/ComparisonExpression";
import { iff } from "../../src/core/expressions/CaseExpression";
import sql from "../../src/utils/sqlTag";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
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
  counter: "iqb_counter",
  reading: "iqb_reading",
  stamped: "iqb_stamped",
} as const;

type Marker = {
  mac: string;
  bucketStart: number;
  records: number;
  lastTs: number;
};
type Counter = {
  id: number;
  slug: string;
  hits: number;
};
type Partial_ = {
  id: number;
  mac: string;
  hits: number;
  archivedAt: Date | null;
};
type Reading = {
  id: number;
  mac: string;
  bucketStart: number;
  ts: number;
};
type Stamped = {
  mac: string;
  records: number;
  updatedAt: Date;
  version: number;
};

describe.each(drivers)(
  "[Integration][$label] InsertQueryBuilder ON CONFLICT",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let MarkerE: new () => Marker;
    let PartialE: new () => Partial_;
    let CounterE: new () => Counter;
    let ReadingE: new () => Reading;
    let StampedE: new () => Stamped;

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

          @Entity({ name: TABLES.counter })
          @UniqueIndex(["slug"])
          class CounterEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 32 }) slug!: string;
            @Column({ type: "int" }) hits!: number;
          }

          @Entity({ name: TABLES.reading })
          class ReadingEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 32 }) mac!: string;
            @Column({ type: "int" }) bucketStart!: number;
            @Column({ type: "int" }) ts!: number;
          }

          @Entity({ name: TABLES.stamped })
          class StampedEntity {
            @PrimaryColumn({ type: "varchar", length: 32 }) mac!: string;
            @Column({ type: "int" }) records!: number;
            @UpdateTimestamp() updatedAt!: Date;
            @Version() version!: number;
          }

          MarkerE = MarkerEntity;
          PartialE = PartialEntity;
          CounterE = CounterEntity;
          ReadingE = ReadingEntity;
          StampedE = StampedEntity;
          return {
            entities: [
              MarkerEntity,
              PartialEntity,
              CounterEntity,
              ReadingEntity,
              StampedEntity,
            ],
          };
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
      for (const t of Object.values(TABLES)) {
        try {
          await dropTestTable(t);
        } catch {
          /* ignore */
        }
      }
      await conn.cleanup();
    });

    beforeEach(async () => {
      for (const t of Object.values(TABLES)) {
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

    describe("executeAndReturn()", () => {
      const bump = (slug: string, hits: number) =>
        em
          .createInsertBuilder(CounterE)
          .values({ slug, hits } as any)
          .onConflict(["slug"] as any)
          .doUpdate((t: any, ex: any) => ({ hits: t.hits.add(ex.hits) }))
          .executeAndReturn();

      it("returns the inserted row, then the same row with the accumulated value", async () => {
        const [inserted] = await bump("a", 2);
        const [updated] = await bump("a", 3);

        expect(inserted).toBeInstanceOf(CounterE);
        expect(inserted).toMatchObject({ slug: "a", hits: 2 });
        expect(updated).toMatchObject({ id: inserted.id, slug: "a", hits: 5 });
      });

      it("reads a stated composite key back with the values the conflict action computed", async () => {
        const write = (row: Partial<Marker>) =>
          em
            .createInsertBuilder(MarkerE)
            .values(row as any)
            .onConflict(["mac", "bucketStart"] as any)
            .doUpdate((t: any, ex: any) => ({
              records: t.records.add(ex.records),
              lastTs: greatest(t.lastTs, ex.lastTs),
            }))
            .executeAndReturn();

        await write({ mac: "aa", bucketStart: 100, records: 5, lastTs: 150 });
        const rows = await write({ mac: "aa", bucketStart: 100, records: 7, lastTs: 120 });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ mac: "aa", bucketStart: 100, records: 12, lastTs: 150 });
      });

      it("returns nothing for a row doNothing() skipped", async () => {
        await bump("a", 1);

        const rows = await em
          .createInsertBuilder(CounterE)
          .values({ slug: "a", hits: 50 } as any)
          .onConflict(["slug"] as any)
          .doNothing()
          .executeAndReturn();

        expect(rows).toEqual([]);
        const [stored] = await em.find(CounterE, { where: { slug: "a" } } as any);
        expect(stored.hits).toBe(1);
      });

      if (type === "postgres") {
        it("returns every row a multi-row upsert wrote", async () => {
          await bump("a", 1);

          const rows = await em
            .createInsertBuilder(CounterE)
            .values([
              { slug: "a", hits: 2 },
              { slug: "b", hits: 3 },
            ] as any)
            .onConflict(["slug"] as any)
            .doUpdate((t: any, ex: any) => ({ hits: t.hits.add(ex.hits) }))
            .executeAndReturn();

          expect(rows.map((r) => [r.slug, r.hits]).sort()).toEqual([
            ["a", 3],
            ["b", 3],
          ]);
        });
      }

      if (type === "mysql") {
        it("refuses a multi-row upsert before sending anything", async () => {
          await expect(
            em
              .createInsertBuilder(CounterE)
              .values([
                { slug: "a", hits: 1 },
                { slug: "b", hits: 1 },
              ] as any)
              .onConflict(["slug"] as any)
              .doUpdate(["hits"] as any)
              .executeAndReturn(),
          ).rejects.toThrow(/one row per call/);
          expect(await em.find(CounterE)).toEqual([]);
        });

        it("returns a multi-row plain INSERT only where the server has INSERT ... RETURNING", async () => {
          const insert = () =>
            em
              .createInsertBuilder(CounterE)
              .values([
                { slug: "a", hits: 1 },
                { slug: "b", hits: 2 },
              ] as any)
              .executeAndReturn();

          if (em.getDriver()!.supportsInsertReturning?.()) {
            // MariaDB 10.5+
            const rows = await insert();
            expect(rows.map((r) => [r.slug, r.hits])).toEqual([
              ["a", 1],
              ["b", 2],
            ]);
          } else {
            await expect(insert()).rejects.toThrow(/one row per call/);
          }
        });
      }
    });

    it("reads a proposed column the rows leave out as its default", async () => {
      // MySQL 8.0.19+ reads the proposed row through a row alias that holds
      // only the listed columns, so the unlisted one must be listed as DEFAULT
      // to read what VALUES(col) / EXCLUDED.col read: the column default.
      await em
        .createInsertBuilder(PartialE)
        .values({
          id: 1,
          mac: "a",
          hits: 1,
          archivedAt: new Date("2026-01-01T00:00:00Z"),
        } as any)
        .execute();

      await em
        .createInsertBuilder(PartialE)
        .values({ id: 1, mac: "a", hits: 2 } as any)
        .onConflict(["id"] as any)
        .doUpdate(["hits", "archivedAt"] as any)
        .execute();

      const [row] = (await em.find(PartialE, {} as any)) as Partial_[];
      expect(row.hits).toBe(2);
      expect(row.archivedAt).toBeNull();
    });

    describe("INSERT … SELECT", () => {
      // The entity class exists only once beforeAll has run.
      const reading = (): any => qAlias(ReadingE, "r");

      /** Readings per (mac, bucket): how many, and the latest timestamp. */
      function rollupQuery() {
        const r = reading();
        return em
          .createQueryBuilder(ReadingE, "r")
          .select([
            r.mac.as("mac"),
            r.bucketStart.as("bucketStart"),
            r.id.count().as("records"),
            r.ts.max().as("lastTs"),
          ] as any)
          .groupBy(["r.mac", "r.bucketStart"]);
      }

      function rollup() {
        return em
          .createInsertBuilder(MarkerE)
          .values(["mac", "bucketStart", "records", "lastTs"], rollupQuery())
          .onConflict(["mac", "bucketStart"] as any)
          .doUpdate((t: any, ex: any) => ({
            records: t.records.add(ex.records),
            lastTs: greatest(t.lastTs, ex.lastTs),
          }));
      }

      beforeEach(async () => {
        await em.insertMany(ReadingE, [
          { mac: "aa", bucketStart: 100, ts: 10 },
          { mac: "aa", bucketStart: 100, ts: 30 },
          { mac: "bb", bucketStart: 100, ts: 20 },
        ] as any);
      });

      it("rolls a query's rows up, then accumulates into them on a rerun", async () => {
        await rollup().execute();
        await em.insertMany(ReadingE, [{ mac: "aa", bucketStart: 100, ts: 25 }] as any);
        await rollup().execute();

        expect(await readAll()).toEqual([
          { mac: "aa", bucketStart: 100, records: 5, lastTs: 30 },
          { mac: "bb", bucketStart: 100, records: 2, lastTs: 20 },
        ]);
      });

      it("fills the managed columns, also behind a DISTINCT query", async () => {
        // PostgreSQL types a parameter inside a DISTINCT select list as
        // text, which the timestamp column would reject.
        const r = reading();
        await em
          .createInsertBuilder(StampedE)
          .values(
            ["mac", "records"],
            em
              .createQueryBuilder(ReadingE, "r")
              .select([r.mac.as("mac"), r.bucketStart.as("records")] as any)
              .setDistinct(),
          )
          .execute();

        const rows = (await em.find(StampedE, {
          orderBy: { mac: "ASC" },
        } as any)) as Stamped[];
        expect(rows.map(({ mac, records, version }) => ({ mac, records, version }))).toEqual([
          { mac: "aa", records: 100, version: 1 },
          { mac: "bb", records: 100, version: 1 },
        ]);
        expect(rows[0].updatedAt).toBeInstanceOf(Date);
      });

      if (type === "postgres") {
        it("returns the rows it wrote", async () => {
          await rollup().execute();
          const written = (await rollup().executeAndReturn()) as Marker[];
          expect(
            written.map((m) => ({ ...m })).sort((a, b) => a.mac.localeCompare(b.mac)),
          ).toEqual([
            { mac: "aa", bucketStart: 100, records: 4, lastTs: 30 },
            { mac: "bb", bucketStart: 100, records: 2, lastTs: 20 },
          ]);
        });
      } else {
        it("refuses executeAndReturn() with a conflict action before sending anything", async () => {
          await expect(rollup().executeAndReturn()).rejects.toMatchObject({
            code: OrmErrorCode.UNSUPPORTED_OPERATION,
          });
          expect(await readAll()).toEqual([]);
        });

        it("returns a plain INSERT … SELECT's rows only where the server has INSERT ... RETURNING", async () => {
          const insert = () =>
            em
              .createInsertBuilder(MarkerE)
              .values(["mac", "bucketStart", "records", "lastTs"], rollupQuery())
              .executeAndReturn();

          if (em.getDriver()!.supportsInsertReturning?.()) {
            // MariaDB 10.5+
            const rows = (await insert()) as Marker[];
            expect(
              rows.map((m) => [m.mac, m.records]).sort(),
            ).toEqual([
              ["aa", 2],
              ["bb", 1],
            ]);
          } else {
            await expect(insert()).rejects.toMatchObject({
              code: OrmErrorCode.UNSUPPORTED_OPERATION,
            });
            expect(await readAll()).toEqual([]);
          }
        });
      }
    });

    if (type === "mysql") {
      describe("ON DUPLICATE KEY UPDATE", () => {
        /** Runs `write` and reads the server's warnings for it on the same session. */
        async function warningsOf(
          write: (tx: EntityManager) => Promise<unknown>,
        ): Promise<Array<{ Code: number; Message: string }>> {
          return em.transaction(async (tx) => {
            await write(tx);
            return tx.query(sql`SHOW WARNINGS`);
          });
        }

        it("raises no warning — VALUES() is deprecated on MySQL 8.0.20+", async () => {
          await accumulate([{ mac: "aa", bucketStart: 100, records: 1, lastTs: 1 }]);

          expect(
            await warningsOf((tx) =>
              tx
                .createInsertBuilder(MarkerE)
                .values({ mac: "aa", bucketStart: 100, records: 2, lastTs: 2 } as any)
                .onConflict(["mac", "bucketStart"] as any)
                .doUpdate(["records", "lastTs"] as any)
                .execute(),
            ),
          ).toEqual([]);
          expect(
            await warningsOf((tx) =>
              tx.upsert(MarkerE, { mac: "aa", bucketStart: 100, records: 3, lastTs: 3 }),
            ),
          ).toEqual([]);
          expect(
            await warningsOf((tx) =>
              tx.batchUpsert(MarkerE, [
                { mac: "aa", bucketStart: 100, records: 4, lastTs: 4 },
                { mac: "bb", bucketStart: 100, records: 5, lastTs: 5 },
              ]),
            ),
          ).toEqual([]);
          expect(await readAll()).toEqual([
            { mac: "aa", bucketStart: 100, records: 4, lastTs: 4 },
            { mac: "bb", bucketStart: 100, records: 5, lastTs: 5 },
          ]);
        });

        it("raises no warning for an INSERT … SELECT either", async () => {
          // The SELECT form takes no row alias; MySQL 8.0.19+ reads the
          // proposed row from a derived table instead of VALUES().
          await em.insertMany(ReadingE, [
            { mac: "aa", bucketStart: 100, ts: 10 },
            { mac: "aa", bucketStart: 100, ts: 30 },
          ] as any);
          const r: any = qAlias(ReadingE, "r");
          const rollup = (tx: EntityManager) =>
            tx
              .createInsertBuilder(MarkerE)
              .values(
                ["mac", "bucketStart", "records", "lastTs"],
                tx
                  .createQueryBuilder(ReadingE, "r")
                  .select([
                    r.mac.as("mac"),
                    r.bucketStart.as("bucketStart"),
                    r.id.count().as("records"),
                    r.ts.max().as("lastTs"),
                  ] as any)
                  .groupBy(["r.mac", "r.bucketStart"]),
              )
              .onConflict(["mac", "bucketStart"] as any)
              .doUpdate((t: any, ex: any) => ({
                records: t.records.add(ex.records),
                lastTs: sql`lastTs + 1`,
              }))
              .execute();

          expect(await warningsOf(rollup)).toEqual([]);
          expect(await warningsOf(rollup)).toEqual([]);
          // The raw fragment's bare `lastTs` is the stored row's.
          expect(await readAll()).toEqual([
            { mac: "aa", bucketStart: 100, records: 4, lastTs: 31 },
          ]);
        });

        it("keeps a bare column name in a raw fragment on the stored row", async () => {
          // Under a bare `AS new` the alias's columns share the table's names
          // and MySQL rejects `records` here as ambiguous (ER 1052).
          await accumulate([{ mac: "aa", bucketStart: 100, records: 5, lastTs: 1 }]);

          await em
            .createInsertBuilder(MarkerE)
            .values({ mac: "aa", bucketStart: 100, records: 100, lastTs: 2 } as any)
            .onConflict(["mac", "bucketStart"] as any)
            .doUpdate({ records: sql`records + 1` } as any)
            .execute();

          expect(await readAll()).toEqual([
            { mac: "aa", bucketStart: 100, records: 6, lastTs: 1 },
          ]);
        });

        it("leaves the stored row alone when nothing of the caller's is left to update", async () => {
          // Every stated column is a conflict column, so the update clause
          // degrades to a bare self-assignment (`id` = `id`).
          await em.upsert(PartialE, { id: 1, mac: "a", hits: 1 } as any);

          await em.upsert(PartialE, { id: 1, mac: "b", hits: 9 } as any, [
            "id",
            "mac",
            "hits",
          ]);

          const rows = (await em.find(PartialE, {} as any)) as Partial_[];
          expect(rows.map(({ id, mac, hits }) => ({ id, mac, hits }))).toEqual([
            { id: 1, mac: "a", hits: 1 },
          ]);
        });
      });
    }
  },
);
