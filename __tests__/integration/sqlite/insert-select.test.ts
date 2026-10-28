/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `createInsertBuilder().values(columns, query)` — the
 * INSERT … SELECT form — against a real engine.
 *
 * The SQL shape is pinned by the golden tests. This checks what the engine
 * leaves behind: rows rolled up from a query and accumulated on a rerun,
 * the columns the ORM fills itself, and that the query's own scoping (soft
 * delete, tenant) decides which rows are copied.
 */
import "reflect-metadata";
import {
  Column,
  CreateTimestamp,
  DeletedAt,
  DiscriminatorColumn,
  DiscriminatorValue,
  Entity,
  Inheritance,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateTimestamp,
  Version,
} from "../../../src/decorators";
import { EntityManager } from "../../../src/core/EntityManager";
import { qAlias } from "../../../src/core/query-builder/alias/qAlias";
import { greatest } from "../../../src/core/expressions/ComparisonExpression";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

@Entity({ name: "isl_reading" })
class Reading {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 32 }) mac!: string;
  @Column({ type: "int" }) bucket!: number;
  @Column({ type: "int" }) ts!: number;
  @DeletedAt() deletedAt?: Date | null;
}

@Entity({ name: "isl_counter" })
class Counter {
  @PrimaryColumn({ type: "varchar", length: 32 }) mac!: string;
  @PrimaryColumn({ type: "int" }) bucket!: number;
  @Column({ type: "int" }) records!: number;
  @Column({ type: "int" }) lastTs!: number;
}

@Entity({ name: "isl_rollup" })
class Rollup {
  @PrimaryColumn({ type: "varchar", length: 32 }) mac!: string;
  @Column({ type: "int" }) records!: number;
  @CreateTimestamp() createdAt!: Date;
  @UpdateTimestamp() updatedAt!: Date;
  @Version() version!: number;
}

@Entity({ name: "isl_shape" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "kind" })
class Shape {
  @PrimaryColumn({ type: "int" }) id!: number;
  @Column({ type: "varchar", length: 16 }) kind!: string;
}

@Entity({ name: "isl_shape" })
@DiscriminatorValue("circle")
class Circle extends Shape {
  @Column({ type: "int", nullable: true }) radius!: number;
}

const r = qAlias(Reading, "r");

async function makeEm(opts: Record<string, any> = {}): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: [Reading, Counter, Rollup, Shape, Circle],
      synchronize: true,
      logging: false,
      ...opts,
    },
    `isl_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function rowsOf(em: EntityManager, table: string): Promise<any[]> {
  return em.query(`SELECT * FROM "${table}" ORDER BY rowid`);
}

/** Readings per (mac, bucket): how many, and the latest timestamp. */
function rollupQuery(em: EntityManager) {
  return em
    .createQueryBuilder(Reading, "r")
    .select([
      r.mac.as("mac"),
      r.bucket.as("bucket"),
      r.id.count().as("records"),
      r.ts.max().as("lastTs"),
    ])
    .groupBy(["r.mac", "r.bucket"]);
}

describe("[Integration] SQLite: INSERT … SELECT through createInsertBuilder()", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm();
    await em.insertMany(Reading, [
      { mac: "aa", bucket: 1, ts: 10 },
      { mac: "aa", bucket: 1, ts: 30 },
      { mac: "bb", bucket: 1, ts: 20 },
    ] as any);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  const accumulate = () =>
    em
      .createInsertBuilder(Counter)
      .values(["mac", "bucket", "records", "lastTs"], rollupQuery(em))
      .onConflict(["mac", "bucket"])
      .doUpdate((t, ex) => ({
        records: t.records.add(ex.records),
        lastTs: greatest(t.lastTs, ex.lastTs),
      }));

  it("rolls the query's rows up, then accumulates into them on a rerun", async () => {
    expect((await accumulate().execute()).affected).toBe(2);

    await em.insertMany(Reading, [{ mac: "aa", bucket: 1, ts: 25 }] as any);
    await accumulate().execute();

    expect(await rowsOf(em, "isl_counter")).toEqual([
      { mac: "aa", bucket: 1, records: 5, lastTs: 30 },
      { mac: "bb", bucket: 1, records: 2, lastTs: 20 },
    ]);
  });

  it("returns the rows it wrote", async () => {
    await accumulate().execute();
    const written = await accumulate().executeAndReturn();
    expect(written.map((c) => ({ ...c })).sort((a, b) => a.mac.localeCompare(b.mac))).toEqual([
      { mac: "aa", bucket: 1, records: 4, lastTs: 30 },
      { mac: "bb", bucket: 1, records: 2, lastTs: 20 },
    ]);
    expect(written[0]).toBeInstanceOf(Counter);
  });

  it("skips conflicting rows with doNothing()", async () => {
    await em.save(Counter, { mac: "aa", bucket: 1, records: 99, lastTs: 0 } as any);
    const result = await em
      .createInsertBuilder(Counter)
      .values(["mac", "bucket", "records", "lastTs"], rollupQuery(em))
      .onConflict(["mac", "bucket"])
      .doNothing()
      .execute();

    expect(result.affected).toBe(1);
    expect(await rowsOf(em, "isl_counter")).toEqual([
      { mac: "aa", bucket: 1, records: 99, lastTs: 0 },
      { mac: "bb", bucket: 1, records: 1, lastTs: 20 },
    ]);
  });

  it("upserts from a query that ends at its FROM clause", async () => {
    // Followed directly by ON CONFLICT, SQLite parses the ON as a join
    // constraint (`near "DO": syntax error`).
    await em.save(Counter, { mac: "aa", bucket: 1, records: 99, lastTs: 0 } as any);
    await em
      .createInsertBuilder(Counter)
      .values(
        ["mac", "bucket", "records", "lastTs"],
        em
          .createQueryBuilder(Reading, "r")
          .select([r.mac.as("mac"), r.id.as("bucket"), r.ts.as("records"), r.ts.as("lastTs")])
          .withDeleted(),
      )
      .onConflict(["mac", "bucket"])
      .doUpdate(["records"])
      .execute();

    expect(await rowsOf(em, "isl_counter")).toEqual([
      { mac: "aa", bucket: 1, records: 10, lastTs: 0 },
      { mac: "aa", bucket: 2, records: 30, lastTs: 30 },
      { mac: "bb", bucket: 3, records: 20, lastTs: 20 },
    ]);
  });

  it("copies no row the query's soft-delete filter hides", async () => {
    await em.softDelete(Reading, { mac: "bb" } as any);
    await em
      .createInsertBuilder(Counter)
      .values(["mac", "bucket", "records", "lastTs"], rollupQuery(em))
      .execute();

    expect((await rowsOf(em, "isl_counter")).map((row) => row.mac)).toEqual(["aa"]);
  });

  it("fills the managed timestamps and the version seed", async () => {
    const before = Date.now();
    await em
      .createInsertBuilder(Rollup)
      .values(
        ["mac", "records"],
        em
          .createQueryBuilder(Reading, "r")
          .select([r.mac.as("mac"), r.id.count().as("records")])
          .groupBy(["r.mac"]),
      )
      .execute();

    const rows = await em.find(Rollup, { orderBy: { mac: "ASC" } } as any);
    expect(rows.map((row) => [row.mac, row.records, row.version])).toEqual([
      ["aa", 2, 1],
      ["bb", 1, 1],
    ]);
    for (const row of rows) {
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    }
  });

  it("writes a SINGLE_TABLE child's discriminator", async () => {
    await em
      .createInsertBuilder(Circle)
      .values(
        ["id", "radius"],
        em
          .createQueryBuilder(Reading, "r")
          .select([r.id.as("id"), r.ts.as("radius")])
          .where(r.mac.eq("aa")),
      )
      .execute();

    expect(await rowsOf(em, "isl_shape")).toEqual([
      { id: 1, kind: "circle", radius: 10 },
      { id: 2, kind: "circle", radius: 30 },
    ]);
    expect((await em.find(Circle, {})).length).toBe(2);
  });
});

describe("[Integration] SQLite: INSERT … SELECT under tenant_column", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm({ tenantStrategy: "tenant_column" });
    for (const [tenant, mac, ts] of [
      ["acme", "aa", 10],
      ["acme", "aa", 30],
      ["globex", "aa", 50],
      ["globex", "gg", 70],
    ] as const) {
      await MetadataContext.run(tenant, () =>
        em.save(Reading, { mac, bucket: 1, ts } as any),
      );
    }
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  const rollup = () =>
    em
      .createInsertBuilder(Counter)
      .values(["mac", "bucket", "records", "lastTs"], rollupQuery(em))
      .onConflict(["mac", "bucket"])
      .doUpdate(["records", "lastTs"]);

  it("copies the active tenant's rows and stamps them with that tenant", async () => {
    await MetadataContext.run("acme", () => rollup().execute());

    expect(await rowsOf(em, "isl_counter")).toEqual([
      { mac: "aa", bucket: 1, records: 2, lastTs: 30, tenant_id: "acme" },
    ]);
  });

  it("leaves another tenant's conflicting row as it is", async () => {
    await MetadataContext.run("globex", () => rollup().execute());
    await MetadataContext.run("acme", () => rollup().execute());

    expect(await rowsOf(em, "isl_counter")).toEqual([
      { mac: "aa", bucket: 1, records: 1, lastTs: 50, tenant_id: "globex" },
      { mac: "gg", bucket: 1, records: 1, lastTs: 70, tenant_id: "globex" },
    ]);
  });

  it("rejects the tenant column in the column list", async () => {
    const attempt = MetadataContext.run("acme", () =>
      em
        .createInsertBuilder(Counter)
        .values(
          ["mac", "bucket", "records", "lastTs", "tenant_id" as "mac"],
          rollupQuery(em).addSelect("'globex'", "tenant_id"),
        )
        .execute(),
    );
    await expect(attempt).rejects.toMatchObject({
      code: OrmErrorCode.INVALID_QUERY,
      message: expect.stringContaining("is the tenant column of Counter"),
    });
    expect(await rowsOf(em, "isl_counter")).toEqual([]);
  });

  it("refuses to run outside a tenant context", async () => {
    await expect(rollup().execute()).rejects.toMatchObject({
      code: OrmErrorCode.MISSING_TENANT_CONTEXT,
    });
  });
});
