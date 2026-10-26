/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `createInsertBuilder().executeAndReturn()`.
 *
 * The rows come from `RETURNING *`, so what is pinned here is which rows the
 * statement reports — inserted rows and rows the conflict action updated,
 * with the values the database computed, but never a row the statement
 * skipped — and that they hydrate like a read of the entity.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryColumn } from "../../../src/decorators/PrimaryColumn";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { UniqueIndex } from "../../../src/decorators/UniqueIndex";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { qAlias } from "../../../src/core/query-builder/alias/qAlias";
import { greatest } from "../../../src/core/expressions/ComparisonExpression";

@Entity({ name: "iqr_marker" })
class IqrMarker {
  @PrimaryColumn({ type: "varchar", length: 32 }) mac!: string;
  @PrimaryColumn({ type: "int" }) bucketStart!: number;
  @Column({ type: "int" }) records!: number;
  @Column({ type: "int", name: "last_ts" }) lastTs!: number;
}

@Entity({ name: "iqr_counter" })
@UniqueIndex(["slug"])
class IqrCounter {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column({ type: "int" }) hits!: number;
  @Column({ type: "varchar", default: "new" }) status!: string;
}

async function makeEm(opts: Record<string, any> = {}): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: [IqrMarker, IqrCounter],
      synchronize: true,
      logging: false,
      ...opts,
    },
    `iqr_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

describe("[Integration] SQLite: InsertQueryBuilder.executeAndReturn()", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm();
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  const accumulate = (rows: Array<Partial<IqrMarker>>) =>
    em
      .createInsertBuilder(IqrMarker)
      .values(rows)
      .onConflict(["mac", "bucketStart"])
      .doUpdate((t, ex) => ({
        records: t.records.add(ex.records),
        lastTs: greatest(t.lastTs, ex.lastTs),
      }))
      .executeAndReturn();

  it("returns inserted rows as entity instances with generated keys and defaults", async () => {
    const rows = await em
      .createInsertBuilder(IqrCounter)
      .values([
        { slug: "a", hits: 1 },
        { slug: "b", hits: 2 },
      ])
      .executeAndReturn();

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row instanceof IqrCounter)).toBe(true);
    expect(rows.map((r) => [typeof r.id, r.slug, r.hits, r.status])).toEqual([
      ["number", "a", 1, "new"],
      ["number", "b", 2, "new"],
    ]);
  });

  it("returns the values the conflict action computed, mapped back to properties", async () => {
    await accumulate([{ mac: "aa", bucketStart: 100, records: 5, lastTs: 150 }]);
    const [row] = await accumulate([
      { mac: "aa", bucketStart: 100, records: 7, lastTs: 120 },
    ]);

    // `lastTs` is stored as `last_ts`: the row comes back under the property name.
    expect(row).toBeInstanceOf(IqrMarker);
    expect({ ...row }).toEqual({ mac: "aa", bucketStart: 100, records: 12, lastTs: 150 });
  });

  it("returns both the inserted and the updated rows of one statement", async () => {
    await accumulate([{ mac: "aa", bucketStart: 100, records: 1, lastTs: 1 }]);
    const rows = await accumulate([
      { mac: "aa", bucketStart: 100, records: 2, lastTs: 2 },
      { mac: "bb", bucketStart: 100, records: 3, lastTs: 3 },
    ]);

    expect(rows.map((r) => [r.mac, r.records]).sort()).toEqual([
      ["aa", 3],
      ["bb", 3],
    ]);
  });

  it("leaves out a row that doNothing() skipped", async () => {
    await em.createInsertBuilder(IqrCounter).values({ slug: "a", hits: 1 }).execute();

    const rows = await em
      .createInsertBuilder(IqrCounter)
      .values([
        { slug: "a", hits: 50 },
        { slug: "b", hits: 2 },
      ])
      .onConflict(["slug"])
      .doNothing()
      .executeAndReturn();

    expect(rows.map((r) => [r.slug, r.hits])).toEqual([["b", 2]]);
  });

  it("leaves out a row that doUpdateWhere() filtered", async () => {
    await em
      .createInsertBuilder(IqrCounter)
      .values([
        { slug: "a", hits: 10 },
        { slug: "b", hits: 1 },
      ])
      .execute();
    const c = qAlias(IqrCounter, "c");

    const rows = await em
      .createInsertBuilder(IqrCounter)
      .values([
        { slug: "a", hits: 5 },
        { slug: "b", hits: 5 },
      ])
      .onConflict(["slug"])
      .doUpdate((t, ex) => ({ hits: t.hits.add(ex.hits) }))
      .doUpdateWhere(c.hits.lt(5))
      .executeAndReturn();

    expect(rows.map((r) => [r.slug, r.hits])).toEqual([["b", 6]]);
  });

  it("rejects an empty values list like execute()", async () => {
    const builder = em.createInsertBuilder(IqrCounter).values([]);
    await expect(builder.executeAndReturn()).rejects.toThrow(/no rows to insert/);
  });

  describe("tenant_column", () => {
    beforeEach(async () => {
      await em.propagateShutdown();
      MetadataContext.reset();
      em = await makeEm({ tenantStrategy: "tenant_column" });
      await MetadataContext.run("globex", () =>
        em.createInsertBuilder(IqrCounter).values({ slug: "g1", hits: 100 }).execute(),
      );
    });

    it("does not return another tenant's conflicting row", async () => {
      const rows = await MetadataContext.run("acme", () =>
        em
          .createInsertBuilder(IqrCounter)
          .values({ slug: "g1", hits: 1 })
          .onConflict(["slug"])
          .doUpdate((t, ex) => ({ hits: t.hits.add(ex.hits) }))
          .executeAndReturn(),
      );

      expect(rows).toEqual([]);
      const stored = await MetadataContext.run("globex", () =>
        em.findOne(IqrCounter, { where: { slug: "g1" } }),
      );
      expect(stored?.hits).toBe(100);
    });

    it("returns the caller's own updated row", async () => {
      await MetadataContext.run("acme", () =>
        em.createInsertBuilder(IqrCounter).values({ slug: "a1", hits: 1 }).execute(),
      );

      const rows = await MetadataContext.run("acme", () =>
        em
          .createInsertBuilder(IqrCounter)
          .values({ slug: "a1", hits: 4 })
          .onConflict(["slug"])
          .doUpdate((t, ex) => ({ hits: t.hits.add(ex.hits) }))
          .executeAndReturn(),
      );

      expect(rows.map((r) => [r.slug, r.hits])).toEqual([["a1", 5]]);
    });
  });
});
