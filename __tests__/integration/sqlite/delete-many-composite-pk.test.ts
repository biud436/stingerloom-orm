/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `deleteMany()` on a composite primary key.
 *
 * deleteMany() keyed its DELETE on the first primary key column only and
 * rejected the object form, so `deleteMany(Line, [1])` removed every line of
 * order 1 and there was no way to delete by a full key. It now takes one
 * object per row naming every key column and rejects a scalar.
 */
import "reflect-metadata";
import { Entity, Column, PrimaryColumn } from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

@Entity({ name: "dmc_line" })
class DmcLine {
  @PrimaryColumn({ type: "int" }) orderId!: number;
  @PrimaryColumn({ type: "int", name: "line_no" }) lineNo!: number;
  @Column() sku!: string;
}

async function makeEm(tenant = false) {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: [DmcLine],
      synchronize: true,
      logging: false,
      ...(tenant ? { tenantStrategy: "tenant_column" } : {}),
    } as any,
    `dmc_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function seed(em: EntityManager, keys: Array<[number, number]>) {
  for (const [orderId, lineNo] of keys) {
    await em.save(DmcLine, { orderId, lineNo, sku: `o${orderId}l${lineNo}` });
  }
}

async function skus(em: EntityManager): Promise<string[]> {
  const rows = await em.find(DmcLine, { orderBy: { orderId: "ASC", lineNo: "ASC" } });
  return rows.map((row) => row.sku);
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

describe("[Integration] SQLite: deleteMany() on a composite primary key", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm();
    await seed(em, [[1, 1], [1, 2], [2, 1], [2, 2]]);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("deletes exactly the rows the keys name, not their siblings", async () => {
    const result = await em.deleteMany(DmcLine, [
      { orderId: 1, lineNo: 2 },
      { orderId: 2, lineNo: 1 },
    ]);

    expect(result.affected).toBe(2);
    expect(await skus(em)).toEqual(["o1l1", "o2l2"]);
  });

  it("rejects a scalar id instead of deleting every row that shares it", async () => {
    const error = await rejection(em.deleteMany(DmcLine, [1]));

    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain('composite key (orderId, lineNo)');
    expect(error.message).toContain("at index 0");
    expect(await skus(em)).toEqual(["o1l1", "o1l2", "o2l1", "o2l2"]);
  });

  it("rejects a key missing a column and deletes nothing", async () => {
    const error = await rejection(
      em.deleteMany(DmcLine, [{ orderId: 1, lineNo: 1 }, { orderId: 2 }]),
    );

    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain('"lineNo" at index 1');
    expect(await skus(em)).toEqual(["o1l1", "o1l2", "o2l1", "o2l2"]);
  });

  it("reads a key column under its column name too", async () => {
    const result = await em.deleteMany(DmcLine, [{ orderId: 1, line_no: 2 }]);

    expect(result.affected).toBe(1);
    expect(await skus(em)).toEqual(["o1l1", "o2l1", "o2l2"]);
  });

  it("takes loaded entities as their own keys", async () => {
    const order2 = await em.find(DmcLine, { where: { orderId: 2 } });

    const result = await em.deleteMany(DmcLine, order2);

    expect(result.affected).toBe(2);
    expect(await skus(em)).toEqual(["o1l1", "o1l2"]);
  });

  it("reports the full keys to the delete events", async () => {
    const seen: any[] = [];
    em.on("afterDelete", (event: any) => {
      seen.push(event);
    });

    await em.deleteMany(DmcLine, [{ orderId: 2, lineNo: 2 }]);

    expect(seen).toHaveLength(1);
    expect(seen[0].data).toEqual({ OR: [{ orderId: 2, lineNo: 2 }] });
  });
});

describe("[Integration] SQLite: composite-key deleteMany() under tenant_column", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm(true);
    await MetadataContext.run("acme", () => seed(em, [[1, 1]]));
    await MetadataContext.run("globex", () => seed(em, [[1, 2]]));
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("deletes only the current tenant's rows", async () => {
    const result = await MetadataContext.run("acme", () =>
      em.deleteMany(DmcLine, [{ orderId: 1, lineNo: 1 }, { orderId: 1, lineNo: 2 }]),
    );

    expect(result.affected).toBe(1);
    expect(await MetadataContext.run("globex", () => skus(em))).toEqual(["o1l2"]);
    expect(await MetadataContext.run("acme", () => skus(em))).toEqual([]);
  });
});
