import "reflect-metadata";
import { MultiTenantEntityManager } from "../../src/core/MultiTenantEntityManager";
import { DatabaseClient } from "../../src/DatabaseClient";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { Entity } from "../../src/decorators/Entity";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Column } from "../../src/decorators/Column";

@Entity({ name: "mtem_user" })
class UserE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

const sqliteOpts = (database = ":memory:") => ({
  type: "sqlite" as const,
  database,
  entities: [UserE],
  synchronize: true as const,
  tenantStrategy: "database" as const,
});

afterEach(async () => {
  MetadataContext.reset();
  await DatabaseClient.getInstance().close();
});

describe("MultiTenantEntityManager", () => {
  it("rejects register() without tenantStrategy: database", async () => {
    const em = new MultiTenantEntityManager();
    try {
      await em.register({
        type: "sqlite",
        database: ":memory:",
        entities: [UserE],
        synchronize: true,
      });
      fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OrmError);
      expect((e as OrmError).code).toBe(OrmErrorCode.INVALID_CONFIG);
    }
  });

  it("rejects register() without resolver and without map", async () => {
    const em = new MultiTenantEntityManager();
    try {
      await em.register({
        ...sqliteOpts(),
      });
      fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OrmError);
      expect((e as OrmError).code).toBe(OrmErrorCode.TENANT_RESOLVER_MISSING);
    }
  });

  it("routes save+find to a per-tenant DB and isolates between tenants", async () => {
    const em = new MultiTenantEntityManager();
    await em.register({
      ...sqliteOpts(),
      tenantDatabaseResolver: () => sqliteOpts(),
    });

    await MetadataContext.run("acme", async () => {
      await em.save(UserE, { name: "alice" });
      await em.save(UserE, { name: "bob" });
    });
    await MetadataContext.run("globex", async () => {
      await em.save(UserE, { name: "carol" });
    });

    const acmeUsers = await MetadataContext.run("acme", () => em.find(UserE));
    const globexUsers = await MetadataContext.run("globex", () => em.find(UserE));

    expect((acmeUsers as UserE[]).map((u) => u.name).sort()).toEqual(["alice", "bob"]);
    expect((globexUsers as UserE[]).map((u) => u.name).sort()).toEqual(["carol"]);
  });

  it("uses default EM under public context with publicTenantBehavior: default", async () => {
    const em = new MultiTenantEntityManager();
    await em.register({
      ...sqliteOpts(),
      tenantDatabaseResolver: () => sqliteOpts(),
    });

    // No MetadataContext.run() — falls back to defaultEm.
    const saved = await em.save(UserE, { name: "admin" });
    expect(saved).toBeDefined();
    const fromDefault = await em.getDefaultEntityManager().find(UserE);
    expect((fromDefault as UserE[]).map((u) => u.name)).toEqual(["admin"]);
  });

  it("throws under public context when publicTenantBehavior: throw", async () => {
    const em = new MultiTenantEntityManager();
    await em.register({
      ...sqliteOpts(),
      publicTenantBehavior: "throw",
      tenantDatabaseResolver: () => sqliteOpts(),
    });

    try {
      await em.save(UserE, { name: "should fail" });
      fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OrmError);
      expect((e as OrmError).code).toBe(OrmErrorCode.MISSING_TENANT_CONTEXT);
    }
  });

  it("eagerProvisionTenants connects pools at register() time", async () => {
    let calls = 0;
    const em = new MultiTenantEntityManager();
    await em.register({
      ...sqliteOpts(),
      eagerProvisionTenants: ["acme", "globex"],
      tenantDatabaseResolver: () => {
        calls++;
        return sqliteOpts();
      },
    });

    expect(calls).toBe(2);
    expect(em.getRouter().getResolvedTenants().sort()).toEqual([
      "acme",
      "globex",
    ]);
  });

  it("forEachTenant fans out across resolved tenants", async () => {
    const em = new MultiTenantEntityManager();
    await em.register({
      ...sqliteOpts(),
      tenantDatabaseResolver: () => sqliteOpts(),
    });

    await MetadataContext.run("acme", async () => {
      await em.save(UserE, { name: "alice" });
      await em.save(UserE, { name: "bob" });
    });
    await MetadataContext.run("globex", () => em.save(UserE, { name: "carol" }));

    const counts = await em.forEachTenant(async (tenantEm) =>
      tenantEm.count(UserE),
    );
    const byTenant = Object.fromEntries(counts.map((c) => [c.tenantId, c.value]));
    expect(byTenant).toEqual({ acme: 2, globex: 1 });
  });

  it("transaction throws CROSS_TENANT_TRANSACTION if context shifts mid-tx", async () => {
    const em = new MultiTenantEntityManager();
    await em.register({
      ...sqliteOpts(),
      tenantDatabaseResolver: () => sqliteOpts(),
    });

    let captured: unknown;
    try {
      await MetadataContext.run("acme", async () => {
        await em.transaction(async () => {
          // Switch tenant inside the same transaction — should throw.
          await MetadataContext.run("globex", async () => {
            await em.save(UserE, { name: "should fail" });
          });
        });
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(OrmError);
    expect((captured as OrmError).code).toBe(
      OrmErrorCode.CROSS_TENANT_TRANSACTION,
    );
  });

  it("getRepository proxies through per-tenant EMs at call time", async () => {
    const em = new MultiTenantEntityManager();
    await em.register({
      ...sqliteOpts(),
      tenantDatabaseResolver: () => sqliteOpts(),
    });

    const repo = em.getRepository(UserE);

    await MetadataContext.run("acme", () => repo.save({ name: "alice" } as any));
    await MetadataContext.run("globex", () => repo.save({ name: "bob" } as any));

    const acmeAll = await MetadataContext.run("acme", () => repo.find() as Promise<UserE[]>);
    const globexAll = await MetadataContext.run("globex", () => repo.find() as Promise<UserE[]>);

    expect(acmeAll.map((u) => u.name)).toEqual(["alice"]);
    expect(globexAll.map((u) => u.name)).toEqual(["bob"]);
  });

  it("propagateShutdown closes every tenant pool", async () => {
    const em = new MultiTenantEntityManager();
    await em.register({
      ...sqliteOpts(),
      eagerProvisionTenants: ["acme", "globex"],
      tenantDatabaseResolver: () => sqliteOpts(),
    });

    const beforeNames = DatabaseClient.getInstance().getRegisteredNames();
    expect(beforeNames.length).toBeGreaterThanOrEqual(3); // default + 2 tenants

    await em.propagateShutdown({ closeConnections: true });
    const afterNames = DatabaseClient.getInstance().getRegisteredNames();
    expect(afterNames).toEqual([]);
  });

  it("on() listener fires on per-tenant EMs (broadcast)", async () => {
    const em = new MultiTenantEntityManager();
    await em.register({
      ...sqliteOpts(),
      tenantDatabaseResolver: () => sqliteOpts(),
    });

    const events: Array<{ tenant: string; entity: any }> = [];
    em.on("afterInsert", (event) => {
      events.push({
        tenant: MetadataContext.getCurrentTenant(),
        entity: (event as any).entity,
      });
    });

    await MetadataContext.run("acme", () => em.save(UserE, { name: "alice" }));
    await MetadataContext.run("globex", () => em.save(UserE, { name: "bob" }));

    expect(events.length).toBe(2);
    expect(events.map((e) => e.tenant).sort()).toEqual(["acme", "globex"]);
  });
});
