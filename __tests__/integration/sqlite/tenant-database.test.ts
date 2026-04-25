/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase 7 — tenantStrategy: "database" end-to-end integration test (SQLite).
 *
 * SQLite ":memory:" gives every connection an independent database, which
 * naturally matches the database-per-tenant model — no on-disk file
 * provisioning is required. The tests cover the 12 scenarios from the plan:
 *
 *   1. Pre-registered tenants (tenantDatabaseMap)
 *   2. Lazy provisioning via tenantDatabaseResolver
 *   3. Cross-tenant isolation
 *   4. DDL synchronize per-tenant
 *   5. forEachTenant() admin fan-out
 *   6. Cross-tenant transaction → CROSS_TENANT_TRANSACTION
 *   7. Public context + publicTenantBehavior: "throw"
 *   8. Public context + publicTenantBehavior: "default" routes to admin EM
 *   9. AsyncLocalStorage isolation under concurrent callers
 *  10. Lazy provisioning race — resolver called once per tenant
 *  11. Resolver throw → no caching
 *  12. propagateShutdown closes every pool
 *
 * Runs only under INTEGRATION_TEST=true (see jest.config.js).
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { OrmError } from "../../../src/errors/OrmError";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { MultiTenantEntityManager } from "../../../src/core/MultiTenantEntityManager";

@Entity({ name: "td_user" })
class UserE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

const sqliteOpts = () => ({
  type: "sqlite" as const,
  database: ":memory:",
  entities: [UserE],
  synchronize: true as const,
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

describe("[Integration] SQLite: tenantStrategy database — end-to-end", () => {
  afterEach(async () => {
    MetadataContext.reset();
    await DatabaseClient.getInstance().close();
  });

  // ────────────────────────────────────────────────────────────────
  // 1. Pre-registered tenants (tenantDatabaseMap)
  // ────────────────────────────────────────────────────────────────
  it("1. routes to a pre-registered named connection from tenantDatabaseMap", async () => {
    const client = DatabaseClient.getInstance();
    await client.connect(sqliteOpts(), "preregistered_acme");

    const mtem = new MultiTenantEntityManager();
    await mtem.register({
      ...sqliteOpts(),
      tenantStrategy: "database",
      tenantDatabaseMap: { acme: "preregistered_acme" },
    });

    // Manually run synchronize for the pre-registered pool by routing through
    // the EM the router resolves.
    await MetadataContext.run("acme", async () => {
      // First touch provisions the EM and triggers synchronize=false (caller
      // owns it). Manually create the table via raw query for the test.
      const tenantEm = await mtem.getRouter().resolve("acme");
      await tenantEm.getDriver()!.executeRaw(
        `CREATE TABLE IF NOT EXISTS td_user (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
      );
      await mtem.save(UserE, { name: "alice" });
    });

    const users = (await MetadataContext.run("acme", () =>
      mtem.find(UserE),
    )) as UserE[];
    expect(users.map((u) => u.name)).toEqual(["alice"]);
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Lazy provisioning via resolver
  // ────────────────────────────────────────────────────────────────
  it("2. lazy-provisions tenants via tenantDatabaseResolver and caches the EM", async () => {
    let calls = 0;
    const mtem = await makeMtem({
      tenantDatabaseResolver: () => {
        calls++;
        return sqliteOpts();
      },
    });
    await MetadataContext.run("acme", () => mtem.save(UserE, { name: "alice" }));
    await MetadataContext.run("acme", () => mtem.save(UserE, { name: "bob" }));
    expect(calls).toBe(1);
    const acmeUsers = (await MetadataContext.run("acme", () =>
      mtem.find(UserE),
    )) as UserE[];
    expect(acmeUsers.map((u) => u.name).sort()).toEqual(["alice", "bob"]);
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Cross-tenant isolation
  // ────────────────────────────────────────────────────────────────
  it("3. tenants do not see each other's rows", async () => {
    const mtem = await makeMtem();
    await MetadataContext.run("acme", () => mtem.save(UserE, { name: "alice" }));
    await MetadataContext.run("globex", () =>
      mtem.save(UserE, { name: "carol" }),
    );

    const acme = (await MetadataContext.run("acme", () =>
      mtem.find(UserE),
    )) as UserE[];
    const globex = (await MetadataContext.run("globex", () =>
      mtem.find(UserE),
    )) as UserE[];
    expect(acme.map((u) => u.name)).toEqual(["alice"]);
    expect(globex.map((u) => u.name)).toEqual(["carol"]);
  });

  // ────────────────────────────────────────────────────────────────
  // 4. DDL synchronize per-tenant
  // ────────────────────────────────────────────────────────────────
  it("4. eagerProvisionTenants creates tables per-tenant up front", async () => {
    const mtem = await makeMtem({
      eagerProvisionTenants: ["acme", "globex"],
    });
    expect(mtem.getRouter().getResolvedTenants().sort()).toEqual([
      "acme",
      "globex",
    ]);
    for (const { tenantId, em: tenantEm } of mtem.getRouter().getAll()) {
      const has = await tenantEm.getDriver()!.hasTable("td_user");
      expect(Array.isArray(has) ? has.length : !!has).toBeTruthy();
      // tenantEm.count under that tenant id resolves via context, but the
      // direct call already proves the schema landed.
      void tenantId;
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 5. forEachTenant fan-out
  // ────────────────────────────────────────────────────────────────
  it("5. forEachTenant counts each tenant in parallel", async () => {
    const mtem = await makeMtem();
    await MetadataContext.run("acme", async () => {
      await mtem.save(UserE, { name: "a1" });
      await mtem.save(UserE, { name: "a2" });
    });
    await MetadataContext.run("globex", () =>
      mtem.save(UserE, { name: "g1" }),
    );

    const result = await mtem.forEachTenant(async (tenantEm) =>
      tenantEm.count(UserE),
    );
    const map = Object.fromEntries(result.map((r) => [r.tenantId, r.value]));
    expect(map).toEqual({ acme: 2, globex: 1 });
  });

  // ────────────────────────────────────────────────────────────────
  // 6. Cross-tenant transaction guard
  // ────────────────────────────────────────────────────────────────
  it("6. CROSS_TENANT_TRANSACTION fires when context shifts mid-transaction", async () => {
    const mtem = await makeMtem();
    let captured: unknown;
    await MetadataContext.run("acme", async () => {
      try {
        await mtem.transaction(async () => {
          await MetadataContext.run("globex", async () => {
            await mtem.save(UserE, { name: "should fail" });
          });
        });
      } catch (e) {
        captured = e;
      }
    });
    expect(captured).toBeInstanceOf(OrmError);
    expect((captured as OrmError).code).toBe(
      OrmErrorCode.CROSS_TENANT_TRANSACTION,
    );
  });

  // ────────────────────────────────────────────────────────────────
  // 7. publicTenantBehavior: "throw"
  // ────────────────────────────────────────────────────────────────
  it("7. publicTenantBehavior: \"throw\" rejects context-less queries", async () => {
    const mtem = await makeMtem({ publicTenantBehavior: "throw" });
    let captured: unknown;
    try {
      await mtem.save(UserE, { name: "ghost" });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(OrmError);
    expect((captured as OrmError).code).toBe(
      OrmErrorCode.MISSING_TENANT_CONTEXT,
    );
  });

  // ────────────────────────────────────────────────────────────────
  // 8. publicTenantBehavior: "default" routes to admin EM
  // ────────────────────────────────────────────────────────────────
  it("8. publicTenantBehavior: \"default\" routes context-less queries to admin EM", async () => {
    const mtem = await makeMtem({ publicTenantBehavior: "default" });
    await mtem.save(UserE, { name: "admin row" });
    const admin = (await mtem.getDefaultEntityManager().find(UserE)) as UserE[];
    expect(admin.map((u) => u.name)).toEqual(["admin row"]);
  });

  // ────────────────────────────────────────────────────────────────
  // 9. Concurrent AsyncLocalStorage isolation
  // ────────────────────────────────────────────────────────────────
  it("9. parallel tenant calls never cross contaminate", async () => {
    const mtem = await makeMtem();
    const results = await Promise.all([
      MetadataContext.run("acme", () =>
        mtem.save(UserE, { name: "from-acme" }),
      ),
      MetadataContext.run("globex", () =>
        mtem.save(UserE, { name: "from-globex" }),
      ),
      MetadataContext.run("initech", () =>
        mtem.save(UserE, { name: "from-initech" }),
      ),
    ]);
    expect(results.length).toBe(3);

    for (const tenantId of ["acme", "globex", "initech"]) {
      const rows = (await MetadataContext.run(tenantId, () =>
        mtem.find(UserE),
      )) as UserE[];
      expect(rows.map((r) => r.name)).toEqual([`from-${tenantId}`]);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 10. Lazy provisioning race
  // ────────────────────────────────────────────────────────────────
  it("10. concurrent first-resolves of one tenant only call resolver once", async () => {
    // SQLite uses a single connection per pool, so we can't run 10 concurrent
    // INSERTs without "cannot start a transaction within a transaction".
    // The race we care about here is just on resolver invocation — directly
    // calling router.resolve() in parallel is enough.
    let calls = 0;
    const mtem = await makeMtem({
      tenantDatabaseResolver: async () => {
        calls++;
        // simulate slow resolver to widen the race window
        await new Promise((r) => setTimeout(r, 10));
        return sqliteOpts();
      },
    });
    const router = mtem.getRouter();
    const ems = await Promise.all(
      Array.from({ length: 10 }, () => router.resolve("acme")),
    );
    expect(calls).toBe(1);
    // Every parallel resolve hands back the same EM instance.
    expect(new Set(ems).size).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────
  // 11. Resolver throw is not cached
  // ────────────────────────────────────────────────────────────────
  it("11. resolver throw does not poison the cache — retry succeeds", async () => {
    let attempt = 0;
    const mtem = await makeMtem({
      tenantDatabaseResolver: () => {
        attempt++;
        if (attempt === 1) throw new Error("transient");
        return sqliteOpts();
      },
    });
    await expect(
      MetadataContext.run("acme", () => mtem.save(UserE, { name: "alice" })),
    ).rejects.toThrow("transient");
    // Retry succeeds on the second resolver call.
    await MetadataContext.run("acme", () => mtem.save(UserE, { name: "bob" }));
    const rows = (await MetadataContext.run("acme", () =>
      mtem.find(UserE),
    )) as UserE[];
    expect(rows.map((u) => u.name)).toEqual(["bob"]);
  });

  // ────────────────────────────────────────────────────────────────
  // 12. propagateShutdown closes every pool
  // ────────────────────────────────────────────────────────────────
  it("12. propagateShutdown closes every tenant pool plus the admin pool", async () => {
    const mtem = await makeMtem({
      eagerProvisionTenants: ["acme", "globex"],
    });
    expect(
      DatabaseClient.getInstance().getRegisteredNames().length,
    ).toBeGreaterThanOrEqual(3);
    await mtem.propagateShutdown({ closeConnections: true });
    expect(DatabaseClient.getInstance().getRegisteredNames()).toEqual([]);
  });
});
