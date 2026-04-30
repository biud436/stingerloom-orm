/**
 * Concurrent tenant-routing regression coverage for
 * `MultiTenantEntityManager.pickEm()` (#300).
 *
 * The crown-jewel guarantee of `tenantStrategy: "database"` is "tenant A's
 * queries can never hit tenant B's DB". The metadata layer's AsyncLocalStorage
 * propagation is stress-tested elsewhere; this file specifically verifies the
 * EM-level path: 20 parallel ops under different `MetadataContext.run()`
 * envelopes route to the right per-tenant pool, and concurrent
 * `mtem.transaction()` calls under different tenants do not bleed across the
 * `txTenantStorage` boundary even when the callbacks await between operations.
 */

import "reflect-metadata";
import { MultiTenantEntityManager } from "../../src/core/MultiTenantEntityManager";
import { DatabaseClient } from "../../src/DatabaseClient";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { Entity } from "../../src/decorators/Entity";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Column } from "../../src/decorators/Column";

@Entity({ name: "concurrent_user" })
class CUserE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() tenant!: string;
  @Column() name!: string;
}

const sqliteOpts = (database = ":memory:") => ({
  type: "sqlite" as const,
  database,
  entities: [CUserE],
  synchronize: true as const,
  tenantStrategy: "database" as const,
});

afterEach(async () => {
  MetadataContext.reset();
  await DatabaseClient.getInstance().close();
});

describe("MultiTenantEntityManager — concurrent tenant routing (#300)", () => {
  it("20 parallel ops under different MetadataContext.run() envelopes route to the correct tenant DB", async () => {
    const mtem = new MultiTenantEntityManager();
    await mtem.register({
      ...sqliteOpts(),
      tenantDatabaseResolver: () => sqliteOpts(),
    });

    const N = 20;
    const tenants = Array.from({ length: N }, (_, i) => `tenant_${i}`);

    // Each closure inserts a row tagged with its own tenant id, with a small
    // microtask-boundary jitter to force interleaving across tenants. If
    // pickEm() ever cached the tenant id off AsyncLocalStorage onto an
    // instance field, rows would land in the wrong DB.
    await Promise.all(
      tenants.map((t) =>
        MetadataContext.run(t, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          await mtem.save(CUserE, { tenant: t, name: `user-of-${t}` });
        }),
      ),
    );

    // Each tenant's DB must contain exactly one row, and that row must carry
    // its own tenant id. Cross-tenant leakage would either show up as missing
    // rows or as rows tagged with a foreign tenant id.
    const counts = await mtem.forEachTenant(
      async (em, tenantId) => {
        const rows = (await em.find(CUserE)) as CUserE[];
        return { tenantId, count: rows.length, names: rows.map((r) => r.name) };
      },
      { mode: "settled" },
    );

    const byTenant = new Map(
      counts
        .filter((c) => c.value)
        .map((c) => [c.tenantId, c.value as { count: number; names: string[] }]),
    );

    for (const t of tenants) {
      const entry = byTenant.get(t);
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(1);
      expect(entry!.names).toEqual([`user-of-${t}`]);
    }
  });

  it("two transactions on different tenants commit concurrently without seeing each other's rows", async () => {
    const mtem = new MultiTenantEntityManager();
    await mtem.register({
      ...sqliteOpts(),
      tenantDatabaseResolver: () => sqliteOpts(),
    });

    // Resolve both tenants up front so the concurrent transactions don't race
    // on first-time pool provisioning (which has its own dedupe lock and
    // would mask the txTenantStorage assertion).
    await MetadataContext.run("acme", () => mtem.save(CUserE, { tenant: "acme", name: "seed-a" }));
    await MetadataContext.run("globex", () => mtem.save(CUserE, { tenant: "globex", name: "seed-g" }));

    const acmeWork = MetadataContext.run("acme", () =>
      mtem.transaction(async (em) => {
        // Microtask hops inside the tx — txTenantStorage must hold across
        // every await, otherwise the second save would route to the wrong em.
        await em.save(CUserE, { tenant: "acme", name: "tx-a-1" });
        await new Promise((r) => setTimeout(r, 5));
        await em.save(CUserE, { tenant: "acme", name: "tx-a-2" });
      }),
    );
    const globexWork = MetadataContext.run("globex", () =>
      mtem.transaction(async (em) => {
        await em.save(CUserE, { tenant: "globex", name: "tx-g-1" });
        await new Promise((r) => setTimeout(r, 3));
        await em.save(CUserE, { tenant: "globex", name: "tx-g-2" });
      }),
    );

    await Promise.all([acmeWork, globexWork]);

    const acmeRows = (await MetadataContext.run("acme", () =>
      mtem.find(CUserE),
    )) as CUserE[];
    const globexRows = (await MetadataContext.run("globex", () =>
      mtem.find(CUserE),
    )) as CUserE[];

    // Each DB must hold its own seed + its own two tx rows. No foreign rows.
    expect(acmeRows.map((r) => r.name).sort()).toEqual(["seed-a", "tx-a-1", "tx-a-2"]);
    expect(globexRows.map((r) => r.name).sort()).toEqual(["seed-g", "tx-g-1", "tx-g-2"]);
    // Tenant column must match the DB it lives in.
    expect(acmeRows.every((r) => r.tenant === "acme")).toBe(true);
    expect(globexRows.every((r) => r.tenant === "globex")).toBe(true);
  });

  it("a transaction whose callback awaits non-DB I/O does not lose its tenant binding across the microtask boundary", async () => {
    const mtem = new MultiTenantEntityManager();
    await mtem.register({
      ...sqliteOpts(),
      tenantDatabaseResolver: () => sqliteOpts(),
    });
    await MetadataContext.run("acme", () => mtem.save(CUserE, { tenant: "acme", name: "before" }));

    // Schedule a competing tenant's work that runs concurrently; if the inner
    // tx ever lost its binding mid-await it would route the second save to
    // whichever tenant was last active in the metadata storage.
    const competing = MetadataContext.run("globex", () =>
      mtem.save(CUserE, { tenant: "globex", name: "noise" }),
    );

    await MetadataContext.run("acme", () =>
      mtem.transaction(async (em) => {
        await em.save(CUserE, { tenant: "acme", name: "step-1" });
        // Long-ish non-DB await — ensures other microtasks (including the
        // competing globex save above) get a chance to run and potentially
        // mutate AsyncLocalStorage from outside our envelope.
        await new Promise((r) => setTimeout(r, 20));
        await em.save(CUserE, { tenant: "acme", name: "step-2" });
      }),
    );
    await competing;

    const acme = (await MetadataContext.run("acme", () => mtem.find(CUserE))) as CUserE[];
    const globex = (await MetadataContext.run("globex", () =>
      mtem.find(CUserE),
    )) as CUserE[];

    expect(acme.map((r) => r.name).sort()).toEqual(["before", "step-1", "step-2"]);
    expect(globex.map((r) => r.name).sort()).toEqual(["noise"]);
  });
});
