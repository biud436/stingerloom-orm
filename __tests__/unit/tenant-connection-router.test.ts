import "reflect-metadata";
import { TenantConnectionRouter } from "../../src/core/TenantConnectionRouter";
import { DatabaseClient } from "../../src/DatabaseClient";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { Entity } from "../../src/decorators/Entity";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Column } from "../../src/decorators/Column";

@Entity({ name: "rt_user" })
class RtUserEntity {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

const sqliteOpts = (file = ":memory:") => ({
  type: "sqlite" as const,
  database: file,
  entities: [RtUserEntity],
  synchronize: true as const,
});

afterEach(async () => {
  await DatabaseClient.getInstance().close();
});

describe("TenantConnectionRouter", () => {
  it("routes to a pre-registered connection name", async () => {
    const client = DatabaseClient.getInstance();
    await client.connect(sqliteOpts(), "tenant_a_pool");

    const router = new TenantConnectionRouter({
      map: { acme: "tenant_a_pool" },
      entities: [RtUserEntity],
    });

    const em = await router.resolve("acme");
    expect(em).toBeDefined();
    expect(em.getConnectionName()).toBe("tenant_a_pool");

    // Same tenant resolves to same EM (cached).
    const em2 = await router.resolve("acme");
    expect(em2).toBe(em);
  });

  it("provisions a fresh pool when resolver returns options", async () => {
    const router = new TenantConnectionRouter({
      resolver: async (id) => sqliteOpts(),
      entities: [RtUserEntity],
    });

    const em = await router.resolve("globex");
    expect(em.getConnectionName()).toMatch(/^globex__stg_tenant_/);
    expect(DatabaseClient.getInstance().hasConnection(em.getConnectionName())).toBe(true);
  });

  it("dedupes concurrent first resolves of the same tenant", async () => {
    let resolverCalls = 0;
    const router = new TenantConnectionRouter({
      resolver: async (id) => {
        resolverCalls++;
        // Slow first call to ensure parallelism actually exercises the lock.
        await new Promise((r) => setTimeout(r, 10));
        return sqliteOpts();
      },
      entities: [RtUserEntity],
    });

    const [a, b, c] = await Promise.all([
      router.resolve("acme"),
      router.resolve("acme"),
      router.resolve("acme"),
    ]);

    expect(resolverCalls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("does NOT cache resolver failures — retry succeeds", async () => {
    let calls = 0;
    const router = new TenantConnectionRouter({
      resolver: async () => {
        calls++;
        if (calls === 1) throw new Error("transient");
        return sqliteOpts();
      },
      entities: [RtUserEntity],
    });

    await expect(router.resolve("acme")).rejects.toThrow("transient");
    const em = await router.resolve("acme");
    expect(em).toBeDefined();
    expect(calls).toBe(2);
  });

  it("throws TENANT_RESOLVER_MISSING when no map entry and no resolver", async () => {
    const router = new TenantConnectionRouter({
      entities: [RtUserEntity],
    });

    try {
      await router.resolve("unknown");
      fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OrmError);
      expect((e as OrmError).code).toBe(OrmErrorCode.TENANT_RESOLVER_MISSING);
    }
  });

  it("throws NOT_CONNECTED if map points at an unregistered name", async () => {
    const router = new TenantConnectionRouter({
      map: { phantom: "never_registered" },
      entities: [RtUserEntity],
    });

    try {
      await router.resolve("phantom");
      fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OrmError);
      expect((e as OrmError).code).toBe(OrmErrorCode.NOT_CONNECTED);
    }
  });

  it("releaseAll closes router-owned pools but leaves user-registered pools intact", async () => {
    const client = DatabaseClient.getInstance();
    await client.connect(sqliteOpts(), "user_pool");

    const router = new TenantConnectionRouter({
      map: { acme: "user_pool" },
      resolver: async () => sqliteOpts(),
      entities: [RtUserEntity],
    });

    const em1 = await router.resolve("acme"); // user-owned
    const em2 = await router.resolve("globex"); // router-owned
    const ownedName = em2.getConnectionName();

    await router.releaseAll();

    expect(client.hasConnection("user_pool")).toBe(true); // user_pool intact
    expect(client.hasConnection(ownedName)).toBe(false); // router-owned closed
    expect(router.getResolvedTenants()).toEqual([]);
  });

  it("getAll returns each currently-resolved tenant", async () => {
    const router = new TenantConnectionRouter({
      resolver: async () => sqliteOpts(),
      entities: [RtUserEntity],
    });

    expect(router.getAll()).toEqual([]);

    await router.resolve("acme");
    await router.resolve("globex");

    const all = router.getAll().map((e) => e.tenantId).sort();
    expect(all).toEqual(["acme", "globex"]);
  });

  it("sanitizes tenant ids when generating provisioned connection names", async () => {
    const router = new TenantConnectionRouter({
      resolver: async () => sqliteOpts(),
      entities: [RtUserEntity],
    });

    const em = await router.resolve("foo bar/<weird>");
    // All non-[A-Za-z0-9_] characters become underscores.
    expect(em.getConnectionName()).toMatch(/^foo_bar__weird___stg_tenant_/);
  });
});
