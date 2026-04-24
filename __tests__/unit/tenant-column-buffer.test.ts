/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../src/decorators/PrimaryColumn";
import { NonTenantEntity } from "../../src/decorators/TenantColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { bufferPlugin } from "../../src/core/plugin/buffer/bufferPlugin";

/**
 * Phase 7.2 — WriteBuffer identity map keys are tenant-aware under the
 * `"tenant_column"` strategy. Without a tenant prefix, two rows with the
 * same PK (one per tenant) would alias each other in the identity map,
 * leading to cross-tenant data leaks on `getReference`, `findOne` cache
 * hits, or `merge`. Hibernate historically missed this — we do not.
 */
describe("tenant_column — WriteBuffer identity map tenant key", () => {
  // ManualPk entity — we can explicitly set id=1 in two tenants to force
  // a PK collision scenario, which is what the tenant prefix in identity
  // keys is supposed to prevent.
  @Entity()
  class Widget {
    @PrimaryColumn({ type: "int" }) id!: number;
    @Column() name!: string;
  }

  // AutoIncrement entity — PK is globally unique across tenants, used for
  // tests that just care about key prefix content.
  @Entity()
  class AutoWidget {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
  }

  // Plain entity with no tenant strategy attached anywhere in the module —
  // kept separate so we can verify the unprefixed-key path without Reflect
  // metadata from earlier tenant-aware registrations leaking in.
  @Entity()
  class PlainWidget {
    @PrimaryColumn({ type: "int" }) id!: number;
    @Column() name!: string;
  }

  @NonTenantEntity()
  @Entity()
  class GlobalRef {
    @PrimaryGeneratedColumn() id!: number;
    @Column() slug!: string;
  }

  async function makeBufferedEm(entities: any[] = [Widget]) {
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities,
        synchronize: true,
        tenantStrategy: "tenant_column",
      },
      `t_${Math.random().toString(36).slice(2, 10)}`,
    );
    const extended = em.extend(bufferPlugin());
    return { em: extended as any as EntityManager, raw: em };
  }

  beforeEach(() => MetadataContext.reset());

  it("getReference(Entity, 1) returns distinct instances per tenant", async () => {
    const { em, raw } = await makeBufferedEm();
    try {
      const buf = (em as any).buffer();

      const refA = await MetadataContext.run("acme", () =>
        Promise.resolve(buf.getReference(Widget, 1)),
      );
      const refB = await MetadataContext.run("globex", () =>
        Promise.resolve(buf.getReference(Widget, 1)),
      );

      expect(refA).not.toBe(refB);
      // Both are Widget instances with id=1 but belong to separate tenants.
      expect(refA.id).toBe(1);
      expect(refB.id).toBe(1);
    } finally {
      await raw.propagateShutdown({ closeConnections: true });
    }
  });

  it("findOne cache for tenant A is not served to tenant B's PK lookup", async () => {
    // Tenant A has a row with id=5; tenant B has no row at id=5. Without
    // tenant-aware cache keys, B's findOne(id=5) would serve A's cached
    // instance from the identity map. With the prefix, it falls through to
    // the DB (where the tenant WHERE clause returns null) — the correct
    // behaviour.
    const { em, raw } = await makeBufferedEm();
    try {
      await MetadataContext.run("acme", async () => {
        await raw.save(Widget, { id: 5, name: "acme-widget" });
      });

      const buf = (em as any).buffer();

      const acmeLoaded = await MetadataContext.run("acme", () =>
        buf.findOne(Widget, { where: { id: 5 } }),
      );
      expect(acmeLoaded).not.toBeNull();
      expect(acmeLoaded.name).toBe("acme-widget");

      // Tenant B asks for the same PK — there is no row and the cache must
      // NOT return acme's instance. With tenant-aware keys, the lookup goes
      // to the DB, which applies WHERE tenant_id='globex' and returns null.
      const globexLoaded = await MetadataContext.run("globex", () =>
        buf.findOne(Widget, { where: { id: 5 } }),
      );
      expect(globexLoaded).toBeNull();
    } finally {
      await raw.propagateShutdown({ closeConnections: true });
    }
  });

  it("identity map tracks same-PK instances from two tenants without conflict", async () => {
    // Cross-tenant PK collision is only possible in-memory (the DB's single
    // PK constraint prevents two rows with id=1). The buffer must still
    // behave correctly: getReference under each tenant gets tracked without
    // an identity-conflict throw, and both live side-by-side in the map.
    const { em, raw } = await makeBufferedEm();
    try {
      const buf = (em as any).buffer();

      const refA = await MetadataContext.run("acme", () =>
        Promise.resolve(buf.getReference(Widget, 1)),
      );
      const refB = await MetadataContext.run("globex", () =>
        Promise.resolve(buf.getReference(Widget, 1)),
      );

      expect(refA).not.toBe(refB);
      expect(buf.size().identityMap).toBe(2);

      const keys = Array.from((buf as any).idMap.identityMap.keys()) as string[];
      expect(keys).toContain("acme|Widget:id=1");
      expect(keys).toContain("globex|Widget:id=1");
    } finally {
      await raw.propagateShutdown({ closeConnections: true });
    }
  });

  it("first-level cache is bypassed inside runUnscoped()", async () => {
    // Under runUnscoped, resolveTenantPrefixFromContext returns null → the
    // cache key is not built and the lookup falls through to the DB. We
    // verify the skip by checking that tryBuildCacheKey returns null for
    // the unscoped case but produces a tenant-prefixed key otherwise.
    const { em, raw } = await makeBufferedEm();
    try {
      const buf = (em as any).buffer();
      const idMap = (buf as any).idMap;

      const scopedKey = MetadataContext.run("acme", () =>
        idMap.tryBuildCacheKey(Widget, { where: { id: 1 } }),
      );
      expect(scopedKey).toBe("acme|Widget:id=1");

      const unscopedKey = MetadataContext.run("acme", () =>
        MetadataContext.runUnscoped(() =>
          idMap.tryBuildCacheKey(Widget, { where: { id: 1 } }),
        ),
      );
      expect(unscopedKey).toBeNull();
    } finally {
      await raw.propagateShutdown({ closeConnections: true });
    }
  });

  it("@NonTenantEntity uses unprefixed keys across tenant contexts", async () => {
    const { em, raw } = await makeBufferedEm([GlobalRef]);
    try {
      await raw.save(GlobalRef, { slug: "shared" });

      const buf = (em as any).buffer();

      const refA = await MetadataContext.run("acme", () =>
        buf.findOne(GlobalRef, { where: { id: 1 } }),
      );
      const refB = await MetadataContext.run("globex", () =>
        buf.findOne(GlobalRef, { where: { id: 1 } }),
      );

      // Shared (non-tenant) rows share the same identity — no tenant prefix.
      expect(refA).toBe(refB);
      expect(buf.size().identityMap).toBe(1);
    } finally {
      await raw.propagateShutdown({ closeConnections: true });
    }
  });

  it("identity map is unprefixed when tenant_column strategy is inactive", async () => {
    // PlainWidget is only ever registered without a tenant strategy, so no
    // Reflect metadata for a tenant column is ever attached to its prototype.
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [PlainWidget],
        synchronize: true,
      },
      `t_${Math.random().toString(36).slice(2, 10)}`,
    );
    const extended = em.extend(bufferPlugin());
    try {
      await em.save(PlainWidget, { id: 1, name: "w1" });
      const buf = (extended as any).buffer();
      const loaded = await buf.findOne(PlainWidget, { where: { id: 1 } });
      expect(loaded).not.toBeNull();

      const keys = Array.from((buf as any).idMap.identityMap.keys());
      expect(keys).toContain("PlainWidget:id=1");
      // No tenant prefix like "foo|PlainWidget:id=1"
      expect(keys.every((k) => !/^[a-z]+\|PlainWidget/.test(String(k)))).toBe(true);
    } finally {
      await em.propagateShutdown({ closeConnections: true });
    }
  });

  it("identity map keys include the tenant prefix when strategy is active", async () => {
    const { em, raw } = await makeBufferedEm([AutoWidget]);
    try {
      await MetadataContext.run("acme", async () => {
        await raw.save(AutoWidget, { name: "acme-widget" });
      });
      const buf = (em as any).buffer();

      await MetadataContext.run("acme", () =>
        buf.findOne(AutoWidget, { where: { id: 1 } }),
      );

      const keys = Array.from((buf as any).idMap.identityMap.keys());
      expect(keys).toContain("acme|AutoWidget:id=1");
    } finally {
      await raw.propagateShutdown({ closeConnections: true });
    }
  });
});
