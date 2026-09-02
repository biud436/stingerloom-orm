/**
 * SQLite integration tests for `em.createInsertBuilder()`.
 *
 * The point of the builder is a conflict action that *reads* the stored row —
 * `records = records + excluded.records`, `MAX(last_time, excluded.last_time)` —
 * which `upsert()` cannot express. Rendering the right SQL is checked by the
 * unit tests; what matters here is that a real engine leaves the right values
 * behind after repeated conflicting writes.
 */

import "reflect-metadata";
import sql, { raw } from "sql-template-tag";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryColumn } from "../../../src";
import { qAlias } from "../../../src/core/query-builder/alias/qAlias";
import { greatest } from "../../../src/core/expressions/ComparisonExpression";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { generateTableName } from "../helpers/create-test-entity";

interface MarkerShape {
  mac: string;
  bucketStart: number;
  records: number;
  lastTs: number;
}

describe("[Integration] SQLite In-Memory: InsertQueryBuilder ON CONFLICT", () => {
  let conn: TestConnectionResult;
  let Marker: new () => MarkerShape;
  let tableName: string;

  beforeAll(async () => {
    tableName = generateTableName("sync_markers");

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

        Reflect.defineMetadata("design:type", String, DynClass.prototype, "mac");
        PrimaryColumn({ type: "varchar", length: 32 })(DynClass.prototype, "mac");

        Reflect.defineMetadata("design:type", Number, DynClass.prototype, "bucketStart");
        PrimaryColumn({ type: "int" })(DynClass.prototype, "bucketStart");

        Reflect.defineMetadata("design:type", Number, DynClass.prototype, "records");
        Column({ type: "int" })(DynClass.prototype, "records");

        Reflect.defineMetadata("design:type", Number, DynClass.prototype, "lastTs");
        Column({ type: "int" })(DynClass.prototype, "lastTs");

        Entity()(DynClass);
        Marker = DynClass;
        return { entities: [DynClass] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  beforeEach(async () => {
    await conn.em.query(sql`DELETE FROM ${raw(`"${tableName}"`)}`);
  });

  /** `records += excluded.records`, `lastTs = MAX(lastTs, excluded.lastTs)`. */
  function accumulate(rows: Array<Partial<MarkerShape>>) {
    const m = qAlias(Marker, "m") as any;
    return conn.em
      .createInsertBuilder(Marker)
      .values(rows as any)
      .onConflict(["mac", "bucketStart"] as any)
      .doUpdate((t: any, ex: any) => ({
        records: t.records.add(ex.records),
        lastTs: greatest(t.lastTs, ex.lastTs),
      }))
      .execute();
  }

  async function readAll(): Promise<MarkerShape[]> {
    return conn.em.find(Marker, {
      orderBy: { bucketStart: "ASC" },
    } as any) as Promise<MarkerShape[]>;
  }

  it("inserts the rows on the first write", async () => {
    await accumulate([
      { mac: "aa", bucketStart: 100, records: 5, lastTs: 150 },
      { mac: "aa", bucketStart: 200, records: 3, lastTs: 250 },
    ]);

    const rows = await readAll();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ bucketStart: 100, records: 5, lastTs: 150 });
    expect(rows[1]).toMatchObject({ bucketStart: 200, records: 3, lastTs: 250 });
  });

  it("accumulates records and keeps the high-water timestamp on conflict", async () => {
    await accumulate([{ mac: "aa", bucketStart: 100, records: 5, lastTs: 150 }]);
    await accumulate([{ mac: "aa", bucketStart: 100, records: 7, lastTs: 190 }]);

    const [row] = await readAll();
    expect(row.records).toBe(12);
    expect(row.lastTs).toBe(190);
  });

  it("keeps the stored timestamp when the proposed one is older", async () => {
    await accumulate([{ mac: "aa", bucketStart: 100, records: 5, lastTs: 500 }]);
    await accumulate([{ mac: "aa", bucketStart: 100, records: 1, lastTs: 400 }]);

    const [row] = await readAll();
    expect(row.records).toBe(6);
    expect(row.lastTs).toBe(500);
  });

  it("accumulates across three rounds without losing a write", async () => {
    for (let round = 0; round < 3; round++) {
      await accumulate([
        { mac: "aa", bucketStart: 100, records: 2, lastTs: 100 + round },
        { mac: "bb", bucketStart: 100, records: 4, lastTs: 200 + round },
      ]);
    }

    const rows = await readAll();
    const byMac = Object.fromEntries(rows.map((r) => [r.mac, r]));
    expect(byMac["aa"].records).toBe(6);
    expect(byMac["aa"].lastTs).toBe(102);
    expect(byMac["bb"].records).toBe(12);
    expect(byMac["bb"].lastTs).toBe(202);
  });

  it("leaves conflicting rows untouched with doNothing()", async () => {
    await accumulate([{ mac: "aa", bucketStart: 100, records: 5, lastTs: 150 }]);

    await conn.em
      .createInsertBuilder(Marker)
      .values({ mac: "aa", bucketStart: 100, records: 999, lastTs: 999 } as any)
      .onConflict(["mac", "bucketStart"] as any)
      .doNothing()
      .execute();

    const [row] = await readAll();
    expect(row.records).toBe(5);
    expect(row.lastTs).toBe(150);
  });

  it("skips the update for rows failing the doUpdateWhere predicate", async () => {
    await accumulate([
      { mac: "aa", bucketStart: 100, records: 5, lastTs: 500 },
      { mac: "bb", bucketStart: 100, records: 5, lastTs: 100 },
    ]);

    const m = qAlias(Marker, "m") as any;
    const ex = qAlias(Marker, "x");

    // Only advance rows whose stored timestamp is behind the proposed one.
    await conn.em
      .createInsertBuilder(Marker)
      .values([
        { mac: "aa", bucketStart: 100, records: 1, lastTs: 300 },
        { mac: "bb", bucketStart: 100, records: 1, lastTs: 300 },
      ] as any)
      .onConflict(["mac", "bucketStart"] as any)
      .doUpdate((t: any, exc: any) => ({ lastTs: exc.lastTs }))
      .doUpdateWhere(m.lastTs.lt(300))
      .execute();

    const rows = await readAll();
    const byMac = Object.fromEntries(rows.map((r) => [r.mac, r]));
    // "aa" was already at 500 → predicate false → untouched.
    expect(byMac["aa"].lastTs).toBe(500);
    // "bb" was at 100 → predicate true → advanced.
    expect(byMac["bb"].lastTs).toBe(300);
    void ex;
  });

  it("applies duplicate conflict keys sequentially on SQLite (PostgreSQL rejects them)", async () => {
    // Engines disagree on a VALUES list that hits the same conflict target
    // twice: SQLite applies the rows one after another, so the accumulation
    // compounds, while PostgreSQL raises "ON CONFLICT DO UPDATE command
    // cannot affect row a second time". Pre-merge duplicates in the caller
    // if the statement has to run on both.
    const result = await accumulate([
      { mac: "aa", bucketStart: 100, records: 1, lastTs: 10 },
      { mac: "aa", bucketStart: 100, records: 2, lastTs: 20 },
    ]);

    expect(result.affected).toBeGreaterThan(0);
    const [row] = await readAll();
    expect(row.records).toBe(3);
    expect(row.lastTs).toBe(20);
  });
});
