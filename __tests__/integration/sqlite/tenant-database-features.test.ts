/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tenantStrategy "database" × ORM feature combinations (SQLite :memory:).
 *
 * Complements the baseline 12-scenario suite (sqlite/tenant-database.test.ts),
 * exercising the strategy together with broader ORM features. SQLite
 * `":memory:"` gives every connection its own DB — perfect for verifying
 * physical isolation without provisioning real catalogs.
 *
 * Combinations covered:
 *   1. Aggregates (count/sum/avg/min/max/exists) per-tenant
 *   2. Soft delete + restore landing in the right tenant DB
 *   3. Repository proxy routing per-call
 *   4. forEachTenant("settled") tolerates a single-tenant failure
 *   5. forEachTenant("sequential") visits each tenant in order
 *   6. Plugin (bufferPlugin) installed once, broadcast to every tenant EM
 *   7. EntityEvent listeners broadcast to every tenant EM
 *   8. EntitySubscriber broadcast to every tenant EM
 *   9. Per-tenant transactions commit only inside that tenant's DB
 *  10. withTenant() helper wraps MetadataContext.run + forwards to em
 *  11. Default EM (admin DB) holds non-tenant rows; tenant rows live elsewhere
 *  12. eagerProvisionTenants + lazy resolver coexist (prewarm + on-demand)
 */

import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { MultiTenantEntityManager } from "../../../src/core/MultiTenantEntityManager";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type {
  EntityEventListener,
  EntityEventType,
} from "../../../src/core/EntityEventEmitter";
import { EntitySubscriber } from "../../../src/core/EntitySubscriber";

@Entity({ name: "tdf_user" })
class UserE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "tdf_invoice" })
class InvoiceE {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) amount!: number;
}

@Entity({ name: "tdf_post" })
class PostE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @DeletedAt() deletedAt!: Date | null;
}

const sqliteOpts = (overrides: Record<string, any> = {}) => ({
  type: "sqlite" as const,
  database: ":memory:",
  entities: [UserE, InvoiceE, PostE],
  synchronize: true as const,
  logging: false,
  ...overrides,
});

async function makeMtem(
  override: Record<string, any> = {},
): Promise<MultiTenantEntityManager> {
  const mtem = new MultiTenantEntityManager();
  await mtem.register({
    ...sqliteOpts(),
    tenantStrategy: "database",
    tenantDatabaseResolver: () => sqliteOpts(),
    ...override,
  });
  return mtem;
}

describe("[Integration] SQLite: tenantStrategy database × feature matrix", () => {
  afterEach(async () => {
    MetadataContext.reset();
    await DatabaseClient.getInstance().close();
  });

  // ─────────────────────────────────────────────────────────
  // 1. Aggregates per-tenant
  // ─────────────────────────────────────────────────────────
  it("aggregates: count/sum/avg/min/max/exists hit only the active tenant DB", async () => {
    const mtem = await makeMtem();
    await MetadataContext.run("acme", async () => {
      for (const a of [10, 20, 30]) await mtem.save(InvoiceE, { amount: a });
    });
    await MetadataContext.run("globex", async () => {
      for (const a of [100, 200]) await mtem.save(InvoiceE, { amount: a });
    });

    await MetadataContext.run("acme", async () => {
      expect(await mtem.count(InvoiceE)).toBe(3);
      expect(await mtem.sum(InvoiceE, "amount")).toBe(60);
      expect(await mtem.avg(InvoiceE, "amount")).toBe(20);
      expect(await mtem.min(InvoiceE, "amount")).toBe(10);
      expect(await mtem.max(InvoiceE, "amount")).toBe(30);
      expect(await mtem.exists(InvoiceE, { amount: 10 } as any)).toBe(true);
      expect(await mtem.exists(InvoiceE, { amount: 100 } as any)).toBe(false);
    });
    await MetadataContext.run("globex", async () => {
      expect(await mtem.count(InvoiceE)).toBe(2);
      expect(await mtem.sum(InvoiceE, "amount")).toBe(300);
      expect(await mtem.exists(InvoiceE, { amount: 100 } as any)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────
  // 2. Soft delete + restore in the right tenant DB
  // ─────────────────────────────────────────────────────────
  it("softDelete and restore land in the tenant's physical DB only", async () => {
    const mtem = await makeMtem();
    const acmePost = (await MetadataContext.run("acme", () =>
      mtem.save(PostE, { title: "shared-title" }),
    )) as PostE;
    await MetadataContext.run("globex", () =>
      mtem.save(PostE, { title: "shared-title" }),
    );

    await MetadataContext.run("acme", async () => {
      await mtem.softDelete(PostE, { id: acmePost.id } as any);
      expect((await mtem.find(PostE)).length).toBe(0);
      expect((await mtem.find(PostE, { withDeleted: true } as any)).length).toBe(1);
    });
    await MetadataContext.run("globex", async () => {
      // globex post was never touched.
      const live = (await mtem.find(PostE)) as PostE[];
      expect(live.length).toBe(1);
      expect(live[0].deletedAt).toBeNull();
    });

    // Restore acme's row by title.
    await MetadataContext.run("acme", async () => {
      await mtem.restore(PostE, { title: "shared-title" } as any);
      const live = (await mtem.find(PostE)) as PostE[];
      expect(live.length).toBe(1);
      expect(live[0].deletedAt).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────
  // 3. Repository proxy routes per call
  // ─────────────────────────────────────────────────────────
  it("getRepository() returns a proxy that resolves the right tenant per call", async () => {
    const mtem = await makeMtem();
    const repo = mtem.getRepository(UserE);

    await MetadataContext.run("acme", async () => {
      await repo.save({ name: "alice" } as any);
      await repo.save({ name: "anna" } as any);
    });
    await MetadataContext.run("globex", async () => {
      await repo.save({ name: "carol" } as any);
    });

    await MetadataContext.run("acme", async () => {
      const rows = await repo.find();
      expect(rows.map((r: any) => r.name).sort()).toEqual(["alice", "anna"]);
    });
    await MetadataContext.run("globex", async () => {
      expect(await repo.count()).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────
  // 4. forEachTenant("settled") tolerates one tenant failing
  // ─────────────────────────────────────────────────────────
  it("forEachTenant settled-mode reports per-tenant errors without aborting", async () => {
    const mtem = await makeMtem();
    await MetadataContext.run("acme", () =>
      mtem.save(UserE, { name: "alice" }),
    );
    await MetadataContext.run("globex", () =>
      mtem.save(UserE, { name: "carol" }),
    );

    const result = await mtem.forEachTenant(
      async (tenantEm, tenantId) => {
        if (tenantId === "globex") throw new Error("simulated");
        return tenantEm.count(UserE);
      },
      { mode: "settled" },
    );
    const map = Object.fromEntries(
      result.map((r) => [r.tenantId, r.error ? "ERR" : r.value]),
    );
    expect(map).toEqual({ acme: 1, globex: "ERR" });
  });

  // ─────────────────────────────────────────────────────────
  // 5. forEachTenant("sequential") visits in order
  // ─────────────────────────────────────────────────────────
  it("forEachTenant sequential-mode visits each resolved tenant in order", async () => {
    const mtem = await makeMtem();
    // Pre-warm a deterministic order via direct router.resolve.
    await mtem.getRouter().resolve("alpha");
    await mtem.getRouter().resolve("bravo");
    await mtem.getRouter().resolve("charlie");

    const visited: string[] = [];
    await mtem.forEachTenant(
      async (_em, tenantId) => {
        visited.push(tenantId);
        return tenantId;
      },
      { mode: "sequential" },
    );
    // Order must equal router insertion order.
    expect(visited).toEqual(["alpha", "bravo", "charlie"]);
  });

  // ─────────────────────────────────────────────────────────
  // 6. Plugin broadcast — installed once, applied to every tenant EM
  // ─────────────────────────────────────────────────────────
  it("extend(plugin) reaches both eagerly-provisioned and lazy tenants", async () => {
    const mtem = await makeMtem({
      eagerProvisionTenants: ["acme"],
    });
    mtem.extend(bufferPlugin());

    // Eagerly-provisioned tenant: buffer must already be available.
    await MetadataContext.run("acme", async () => {
      const inst = Object.assign(Object.create(UserE.prototype), {
        name: "buf-a",
      });
      const buf = (await mtem.pickEm()).buffer();
      buf.persist(inst);
      await buf.flush();
      expect(await mtem.count(UserE)).toBe(1);
    });

    // Lazy tenant — provisioned by the very next call. Plugin must apply.
    await MetadataContext.run("globex", async () => {
      const inst = Object.assign(Object.create(UserE.prototype), {
        name: "buf-g",
      });
      const buf = (await mtem.pickEm()).buffer();
      buf.persist(inst);
      await buf.flush();
      expect(await mtem.count(UserE)).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────
  // 7. EntityEvent listeners broadcast to every tenant EM
  // ─────────────────────────────────────────────────────────
  it("on() listeners fire for writes against any tenant EM", async () => {
    const mtem = await makeMtem();
    const seen: Array<{ ev: EntityEventType; name: string }> = [];
    const listener: EntityEventListener = (p) => {
      seen.push({
        ev: "beforeInsert",
        name: (p.data as any).name,
      });
    };
    mtem.on("beforeInsert", listener);
    try {
      await MetadataContext.run("acme", () =>
        mtem.save(UserE, { name: "from-acme" }),
      );
      await MetadataContext.run("globex", () =>
        mtem.save(UserE, { name: "from-globex" }),
      );
    } finally {
      mtem.off("beforeInsert", listener);
    }
    expect(seen.map((s) => s.name).sort()).toEqual(["from-acme", "from-globex"]);
  });

  // ─────────────────────────────────────────────────────────
  // 8. EntitySubscriber broadcast
  // ─────────────────────────────────────────────────────────
  it("addSubscriber() applies to every tenant EM (incl. lazy ones)", async () => {
    const mtem = await makeMtem();
    const seen: string[] = [];
    const sub: EntitySubscriber<UserE> = {
      listenTo: () => UserE,
      afterInsert: async (event: { entity: Partial<UserE> }) => {
        seen.push((event.entity as any).name);
      },
    } as any;
    mtem.addSubscriber(sub);
    try {
      await MetadataContext.run("acme", () =>
        mtem.save(UserE, { name: "sub-a" }),
      );
      await MetadataContext.run("globex", () =>
        mtem.save(UserE, { name: "sub-g" }),
      );
      expect(seen.sort()).toEqual(["sub-a", "sub-g"]);
    } finally {
      mtem.removeSubscriber(sub);
    }
  });

  // ─────────────────────────────────────────────────────────
  // 9. Per-tenant transactions
  // ─────────────────────────────────────────────────────────
  it("transaction() commits inside the tenant's DB only", async () => {
    const mtem = await makeMtem();
    await MetadataContext.run("acme", () =>
      mtem.transaction(async (tx) => {
        await tx.save(UserE, { name: "tx-a-1" });
        await tx.save(UserE, { name: "tx-a-2" });
      }),
    );
    await MetadataContext.run("globex", async () => {
      // globex DB sees nothing.
      expect(await mtem.count(UserE)).toBe(0);
    });
    await MetadataContext.run("acme", async () => {
      expect(await mtem.count(UserE)).toBe(2);
    });
  });

  it("transaction() rollback leaves the tenant DB untouched", async () => {
    const mtem = await makeMtem();
    await MetadataContext.run("acme", async () => {
      await expect(
        mtem.transaction(async (tx) => {
          await tx.save(UserE, { name: "wont-survive" });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await mtem.count(UserE)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // 10. withTenant() helper
  // ─────────────────────────────────────────────────────────
  it("withTenant(id, cb) is equivalent to MetadataContext.run + cb(mtem)", async () => {
    const mtem = await makeMtem();
    const saved = await mtem.withTenant("acme", (em) =>
      em.save(UserE, { name: "via-helper" }),
    );
    expect((saved as any).id).toBeDefined();
    const found = await mtem.withTenant("acme", (em) => em.find(UserE));
    expect(found.map((r: any) => r.name)).toEqual(["via-helper"]);
  });

  // ─────────────────────────────────────────────────────────
  // 11. Admin EM holds public rows; tenant DBs hold tenant rows
  // ─────────────────────────────────────────────────────────
  it("publicTenantBehavior 'default' routes context-less writes to admin DB", async () => {
    const mtem = await makeMtem({ publicTenantBehavior: "default" });

    // Context-less write → admin EM.
    await mtem.save(UserE, { name: "admin-row" });
    // Tenant write → tenant DB.
    await MetadataContext.run("acme", () =>
      mtem.save(UserE, { name: "tenant-row" }),
    );

    const adminRows = (await mtem
      .getDefaultEntityManager()
      .find(UserE)) as UserE[];
    expect(adminRows.map((r) => r.name)).toEqual(["admin-row"]);

    const tenantRows = (await MetadataContext.run("acme", () =>
      mtem.find(UserE),
    )) as UserE[];
    expect(tenantRows.map((r) => r.name)).toEqual(["tenant-row"]);
  });

  // ─────────────────────────────────────────────────────────
  // 12. eagerProvisionTenants + lazy resolver coexist
  // ─────────────────────────────────────────────────────────
  it("eager-provisioned + lazy-resolved tenants both serve queries correctly", async () => {
    const mtem = await makeMtem({
      eagerProvisionTenants: ["acme"],
    });

    // acme is pre-warmed.
    expect(mtem.getRouter().getResolvedTenants()).toContain("acme");

    // globex provisioned on first use.
    await MetadataContext.run("globex", async () => {
      await mtem.save(UserE, { name: "lazy-g" });
    });
    expect(mtem.getRouter().getResolvedTenants().sort()).toEqual([
      "acme",
      "globex",
    ]);

    // Both tenants serve queries independently.
    await MetadataContext.run("acme", async () => {
      await mtem.save(UserE, { name: "eager-a" });
      expect(await mtem.count(UserE)).toBe(1);
    });
    await MetadataContext.run("globex", async () => {
      expect(await mtem.count(UserE)).toBe(1);
    });
  });
});
