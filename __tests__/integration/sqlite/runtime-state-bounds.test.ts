/**
 * SQLite integration test: state an EntityManager keeps for the lifetime of
 * the process stays bounded by the program, not by the data or the tenants
 * that pass through it, and propagateShutdown() lets go of it.
 *
 *  - The `unknownWriteKeys: "warn"` policy remembered every distinct unknown
 *    key of every write payload, and logged each one. The keys come from the
 *    caller's data (often a request body), so a client sending varying junk
 *    keys grew the set and the log without end. Each entity now reports a
 *    limited number of keys, and a long key is cut.
 *  - The query cache memoized the tables a read or a write reaches per
 *    tenant id, so a tenant_column app grew one memo entry per tenant per
 *    entity. The tables follow the entity metadata, which every tenant
 *    without a metadata layer of its own shares.
 *  - propagateShutdown() left the cached row sets and the tenant warning
 *    state in place.
 *
 * Guarded like its siblings: only runs under INTEGRATION_TEST=true.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { EntityManager } from "../../../src/core/EntityManager";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

function warnSpy(em: EntityManager): jest.SpyInstance {
  return jest
    .spyOn((em as unknown as { logger: { warn: (m: string) => void } }).logger, "warn")
    .mockImplementation(() => undefined);
}

describe("[Integration] SQLite: unknown write keys are reported a bounded number of times", () => {
  @Entity({ name: "rsb_docs" })
  class RsbDoc {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) title!: string;
  }

  @Entity({ name: "rsb_notes" })
  class RsbNote {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) body!: string;
  }

  let em: EntityManager;

  beforeAll(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [RsbDoc, RsbNote],
        synchronize: true,
        logging: false,
      },
      "rsb_keys",
    );
  });

  afterAll(async () => {
    await em.propagateShutdown({ closeConnections: true });
  });

  it("stops at 50 distinct keys per entity, saying so once, and keeps writing", async () => {
    const spy = warnSpy(em);
    try {
      for (let i = 0; i < 300; i++) {
        await em.save(RsbDoc, { title: `t${i}`, [`junk_${i}`]: i } as any);
      }
      const messages = spy.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(50);
      expect(messages[0]).toContain(`Unknown key "junk_0"`);
      expect(messages[49]).toContain(`Unknown key "junk_49"`);
      expect(messages[49]).toContain(`further ones are not logged`);
      expect(messages.slice(0, 49).some((m) => m.includes("further ones"))).toBe(false);
      expect((em as any).writeKeyWarned.size).toBe(50);
      expect(await em.count(RsbDoc)).toBe(300);

      // Another entity has its own allowance.
      spy.mockClear();
      await em.save(RsbNote, { body: "b", junk_0: 1 } as any);
      expect(spy.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining(`Unknown key "junk_0" in the data passed to save() for entity "RsbNote"`),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("cuts a long key in what it keeps and logs", async () => {
    (em as any).writeKeyWarned.clear();
    (em as any).unknownWriteKeysReported.clear();
    const spy = warnSpy(em);
    try {
      const long = "k".repeat(5000);
      await em.save(RsbNote, { body: "b", [long]: 1 } as any);
      await em.save(RsbNote, { body: "b", [long]: 1 } as any);

      const messages = spy.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(`Unknown key "${"k".repeat(100)}…"`);
      expect(messages[0].length).toBeLessThan(600);
      const kept = [...(em as any).writeKeyWarned] as string[];
      expect(Math.max(...kept.map((k) => k.length))).toBeLessThan(120);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("[Integration] SQLite: the query cache under many tenants", () => {
  @Entity({ name: "rsb_items" })
  class RsbItem {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
  }

  let em: EntityManager;

  beforeAll(async () => {
    MetadataContext.reset();
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [RsbItem],
        synchronize: true,
        tenantStrategy: "tenant_column",
        logging: false,
      },
      "rsb_tenants",
    );
  });

  afterAll(async () => {
    await em.propagateShutdown({ closeConnections: true });
    MetadataContext.reset();
  });

  const memoOf = (memo: WeakMap<object, WeakMap<object, unknown>>) =>
    memo.get(MetadataLayerRegistry.getInstance().resolveAll() as object)?.get(RsbItem);

  it("keeps one table memo for every tenant that has no metadata layer of its own", async () => {
    for (let i = 0; i < 200; i++) {
      await MetadataContext.run(`tenant_${i}`, async () => {
        await em.find(RsbItem, { cache: true });
        await em.save(RsbItem, { name: `n${i}` });
      });
    }

    const cache = (em as any)._queryCache;
    expect((memoOf(cache.readTagsMemo) as Map<string, string[]>).size).toBe(1);
    expect(memoOf(cache.writeTagsMemo)).toEqual(["t:rsb_items"]);
  });

  it("still serves each tenant its own rows and drops them on that tenant's write", async () => {
    await MetadataContext.run("acme", () => em.save(RsbItem, { name: "a1" }));
    await MetadataContext.run("globex", () => em.save(RsbItem, { name: "g1" }));

    const names = (tenant: string) =>
      MetadataContext.run(tenant, async () =>
        (await em.find(RsbItem, { cache: true, orderBy: { id: "ASC" } })).map((r) => r.name),
      );

    expect(await names("acme")).toEqual(["a1"]);
    expect(await names("globex")).toEqual(["g1"]);
    await MetadataContext.run("acme", () => em.save(RsbItem, { name: "a2" }));
    expect(await names("acme")).toEqual(["a1", "a2"]);
    expect(await names("globex")).toEqual(["g1"]);
  });
});

describe("[Integration] SQLite: propagateShutdown() releases runtime state", () => {
  @Entity({ name: "rsb_rows" })
  class RsbRow {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
  }

  let em: EntityManager;

  beforeAll(async () => {
    MetadataContext.reset();
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [RsbRow],
        synchronize: true,
        tenantStrategy: "tenant_column",
        logging: false,
      },
      "rsb_shutdown",
    );
  });

  afterAll(async () => {
    await em.propagateShutdown({ closeConnections: true });
    MetadataContext.reset();
  });

  it("empties the cached rows and the tenant warnings, and the cache works afterwards", async () => {
    await MetadataContext.run("acme", () => em.save(RsbRow, { name: "r1" }));
    await MetadataContext.run("acme", () => em.find(RsbRow, { cache: true }));
    const spy = warnSpy(em);
    try {
      // Outside a tenant context: the read warns once for the entity.
      await em.find(RsbRow);
    } finally {
      spy.mockRestore();
    }
    expect(em.queryCache!.stats.entries).toBe(1);
    expect((em as any).tenantScope.missingContextWarnedEntities.size).toBe(1);

    await em.propagateShutdown();

    expect(em.queryCache!.stats.entries).toBe(0);
    expect((em as any).tenantScope.missingContextWarnedEntities.size).toBe(0);

    // The connection stays open, and the cache fills again.
    const read = () => MetadataContext.run("acme", () => em.find(RsbRow, { cache: true }));
    const hits = em.queryCache!.stats.hits;
    expect((await read()).map((r) => r.name)).toEqual(["r1"]);
    expect((await read()).map((r) => r.name)).toEqual(["r1"]);
    expect(em.queryCache!.stats.hits).toBe(hits + 1);
  });
});
